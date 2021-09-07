/*!
 * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'

import { StepEstimator, WIZARD_BACK, WIZARD_EXIT } from '../wizards/wizard'
import { QuickInputButton, PrompterButtons } from './buttons'
import { Prompter, PromptResult, Transform } from './prompter'
import { applyPrimitives, isAsyncIterable } from '../utilities/collectionUtils'
import { selectedPreviously } from '../localizedText'

/** Settings applied when using a QuickPickPrompter in 'filter-box input' mode. */
interface FilterBoxInputSettings<T> {
    /** The label of the new QuickPickItem generated by the user's input. */
    label: string
    /** Parses the user's input into a the desired type. */
    transform: (v: string) => PromptResult<T>
    /** The inverse must be provided if using implicit state. */
    inverse?: (output: PromptResult<T>) => string
    /**
     * Checks for any errors in the input.
     * Returned strings are shown in the 'detail' part of the user-input QuickPickItem.
     */
    validator?: (input: string) => string | undefined
}

// Note: 'placeHolder' and 'onDidSelectItem' are ommited since they do not make since in the context of the Prompter
// TODO: remove 'canPickMany' from the omitted properties and implement/test functionality with multiple QuickPick items
/**  Additional options to configure the `QuickPick` beyond the standard API  */
export type ExtendedQuickPickOptions<T> = Omit<
    vscode.QuickPickOptions,
    'canPickMany' | 'placeHolder' | 'onDidSelectItem'
> & {
    title?: string
    value?: string
    step?: number
    placeholder?: string
    totalSteps?: number
    buttons?: PrompterButtons<T>
    /**
     * Setting this option will enable 'filter-box input' mode, allowing the user to create their own QuickInputItem
     * using the filter box as input.
     */
    filterBoxInputSettings?: FilterBoxInputSettings<T>
    /** Used to sort QuickPick items after loading new ones */
    compare?: (a: DataQuickPickItem<T>, b: DataQuickPickItem<T>) => number
    /** Item to show if no items were loaded */
    placeholderItem?: DataQuickPickItem<T>
    /** Item to show if there was an error loading items */
    errorItem?: DataQuickPickItem<T>
    /** Appends 'Selected previously' to the last selected item's detail text (default: true) */
    showSelectedPreviously?: boolean
}

export const DEFAULT_QUICKPICK_OPTIONS: ExtendedQuickPickOptions<any> = {
    ignoreFocusOut: true,
    showSelectedPreviously: true,
}

type QuickPickData<T> = PromptResult<T> | (() => Promise<PromptResult<T>>)
type LabelQuickPickItem<T> = vscode.QuickPickItem & { label: T }

/**
 * Attaches additional information as `data` to a QuickPickItem. Alternatively, `data` can be a function that
 * returns a Promise, evaluated after the user selects the item.
 */
export type DataQuickPickItem<T> = vscode.QuickPickItem & {
    data: QuickPickData<T>
    invalidSelection?: boolean
    onClick?: () => any | Promise<any>
    /** Stops the QuickPick from estimating how many steps an item would add in a Wizard flow */
    skipEstimate?: boolean
}

export type DataQuickPick<T> = Omit<vscode.QuickPick<DataQuickPickItem<T>>, 'buttons'> & { buttons: PrompterButtons<T> }

export const CUSTOM_USER_INPUT = Symbol()

function isDataQuickPickItem(obj: any): obj is DataQuickPickItem<any> {
    return typeof obj === 'object' && typeof (obj as vscode.QuickPickItem).label === 'string' && 'data' in obj
}

/**
 * QuickPick prompts currently support loading:
 * * A plain array of items
 * * A promise for an array of items
 * * An AsyncIterable that generates an array of items every iteration
 */
type ItemLoadTypes<T> = Promise<DataQuickPickItem<T>[]> | DataQuickPickItem<T>[] | AsyncIterable<DataQuickPickItem<T>[]>

/**
 * Creates a UI element that presents a list of items. Information that should be returned when the user selects an
 * item must be placed in the `data` property of each item. If only the `label` is desired, use
 * {@link createLabelQuickPick} instead.
 *
 * @param items An array or a Promise for items.
 * @param options Customizes the QuickPick and QuickPickPrompter.
 * @returns A {@link QuickPickPrompter}. This can be used directly with the `prompt` method or can be fed into a Wizard.
 */
export function createQuickPick<T>(
    items: ItemLoadTypes<T>,
    options?: ExtendedQuickPickOptions<T>
): QuickPickPrompter<T> {
    const picker = vscode.window.createQuickPick<DataQuickPickItem<T>>() as DataQuickPick<T>
    const mergedOptions = { ...DEFAULT_QUICKPICK_OPTIONS, ...options }
    applyPrimitives(picker, mergedOptions)
    picker.buttons = mergedOptions.buttons ?? []

    const prompter =
        mergedOptions.filterBoxInputSettings !== undefined
            ? new FilterBoxQuickPickPrompter<T>(picker, mergedOptions.filterBoxInputSettings)
            : new QuickPickPrompter<T>(picker, mergedOptions)

    prompter.loadItems(items)

    return prompter
}

// Note: the generic type used in `createLabelQuickPick` is needed to infer the correct type when using string
// literal types. Otherwise the narrowness of the type would be lost.
/** Creates a QuickPick from normal QuickPickItems, using the `label` as the return value. */
export function createLabelQuickPick<T extends string>(
    items: LabelQuickPickItem<T>[] | Promise<LabelQuickPickItem<T>[]>,
    options?: ExtendedQuickPickOptions<T>
): QuickPickPrompter<T> {
    if (items instanceof Promise) {
        return createQuickPick(
            items.then(items => items.map(item => ({ data: item.label, ...item }))),
            options
        )
    }
    return createQuickPick(
        items.map(item => ({ data: item.label, ...item })),
        options
    )
}

function acceptItems<T>(picker: DataQuickPick<T>, resolve: (items: DataQuickPickItem<T>[]) => void): void {
    if (picker.selectedItems.length === 0) {
        return
    }

    picker.selectedItems.forEach(item => (item.onClick !== undefined ? item.onClick() : undefined))

    if (picker.selectedItems.some(item => item.invalidSelection)) {
        return
    }

    // TODO: if data is a function => Promise then we need to invoke the function and wait for the Promise
    // to resolve, then we can return (and we should set the picker to be busy/disabled)

    resolve(Array.from(picker.selectedItems))
}

function castDatumToItems<T>(...datum: T[]): DataQuickPickItem<T>[] {
    return datum.map(data => ({ label: '', data }))
}

/**
 * Sets up the QuickPick events. Reject is intentionally not used since errors should be handled through
 * control signals, not exceptions.
 */
function promptUser<T>(
    picker: DataQuickPick<T>,
    onDidShowEmitter: vscode.EventEmitter<void>
): Promise<DataQuickPickItem<T>[] | undefined> {
    return new Promise<DataQuickPickItem<T>[] | undefined>(resolve => {
        picker.onDidAccept(() => acceptItems(picker, resolve))
        picker.onDidHide(() => resolve(castDatumToItems(WIZARD_EXIT)))
        picker.onDidTriggerButton(button => {
            if (button === vscode.QuickInputButtons.Back) {
                resolve(castDatumToItems(WIZARD_BACK))
            } else if ((button as QuickInputButton<T>).onClick !== undefined) {
                const response = (button as QuickInputButton<T>).onClick!()
                if (response !== undefined) {
                    resolve(castDatumToItems(response))
                }
            }
        })
        picker.show()
        onDidShowEmitter.fire()
    }).finally(() => picker.dispose())
}

/**
 * Atempts to recover a QuickPick item given an already processed response.
 *
 * This is generally required when the prompter is being used in a 'saved' state, such as when updating forms
 * that were already submitted. Failed recoveries simply return undefined, which means that the last selected
 * item is unknown (generally the default in this case is to select the first item).
 */
function recoverItemFromData<T>(data: T, items: readonly DataQuickPickItem<T>[]): DataQuickPickItem<T> | undefined {
    const stringified = JSON.stringify(data)

    return items.find(item => {
        if (typeof item.data === 'object') {
            return stringified === JSON.stringify(item.data)
        }

        return typeof item.data === 'function' ? false : data === item.data
    })
}

/**
 * A generic UI element that presents a list of items for the user to select. Wraps around {@link vscode.QuickPick QuickPick}.
 */
export class QuickPickPrompter<T> extends Prompter<T> {
    protected _estimator?: StepEstimator<T>
    protected _lastPicked?: DataQuickPickItem<T>
    private onDidShowEmitter: vscode.EventEmitter<void> = new vscode.EventEmitter()
    private isShowingPlaceholder?: boolean
    /** Event that is fired immediately after the prompter is shown. */
    public onDidShow: vscode.Event<void> = this.onDidShowEmitter.event

    public set lastResponse(response: DataQuickPickItem<T> | undefined) {
        this.setLastResponse(response)
    }

    public get lastResponse() {
        return this._lastPicked
    }

    constructor(
        public readonly quickPick: DataQuickPick<T>,
        protected readonly options: ExtendedQuickPickOptions<T> = {}
    ) {
        super()
    }

    public transform<R>(callback: Transform<T, R>): QuickPickPrompter<R> {
        return super.transform(callback) as QuickPickPrompter<R>
    }

    public setSteps(current: number, total: number): void {
        this.quickPick.step = current
        this.quickPick.totalSteps = total
    }

    public clearItems(): void {
        this.quickPick.items = []
        this.isShowingPlaceholder = false
    }

    /**
     * Applies addtional options to the prompter, merging with any options set during construction
     */
    public applyOptions(options: Omit<ExtendedQuickPickOptions<T>, 'filterBoxInputSettings'>): void {
        this.quickPick.buttons = this.quickPick.buttons.concat(options.buttons ?? [])
        applyPrimitives(this.quickPick, { ...options })
        Object.assign(this.options, options)
    }

    /**
     * Attempts to set the currently selected items. If no matching items were found, the first item in
     * the QuickPick is selected.
     *
     * @param items The items to look for
     */
    public selectItems(...items: DataQuickPickItem<T>[]): void {
        const selected = new Set(items.map(item => item.label))

        // Note: activeItems refer to the 'highlighted' items in a QuickPick, while selectedItems only
        // changes _after_ the user hits enter or clicks something. For a multi-select QuickPick,
        // selectedItems will change as options are clicked (and not when accepting).
        this.quickPick.activeItems = this.quickPick.items.filter(item => selected.has(item.label))

        if (this.quickPick.activeItems.length === 0) {
            this.quickPick.activeItems = [this.quickPick.items[0]]
        }
    }

    /**
     * Appends items to the current array, keeping track of the previous selection
     */
    private appendItems(items: DataQuickPickItem<T>[]): void {
        const picker = this.quickPick
        const previousSelected = picker.activeItems

        picker.items = picker.items.concat(items).sort(this.options.compare)

        if (picker.items.length === 0 && !picker.busy) {
            this.isShowingPlaceholder = true
            picker.items = this.options.placeholderItem !== undefined ? [this.options.placeholderItem] : []
        }

        this.selectItems(...previousSelected)
    }

    // TODO: add options to this to clear items _before_ loading them
    /**
     * Loads items into the QuickPick. Can accept an array or a Promise for items. Promises will cause the
     * QuickPick to become 'busy', disabling user-input until loading is finished. Items are appended to
     * the current set of items. Use `clearItems` prior to loading if this behavior is not desired. The
     * previously selected item will remain selected if it still exists after loading.
     *
     * @param items DataQuickPickItems or a promise for said items
     * @param disableInput Disables the prompter until the items have been loaded, only relevant for async loads
     * @returns A promise that is resolved when loading has finished
     */
    public async loadItems(items: ItemLoadTypes<T>, disableInput?: boolean): Promise<void> {
        const picker = this.quickPick

        if (this.isShowingPlaceholder) {
            this.clearItems()
        }

        picker.busy = true
        picker.enabled = !!disableInput

        if (isAsyncIterable(items)) {
            const iterator = items[Symbol.asyncIterator]() as AsyncIterator<
                DataQuickPickItem<T>[],
                DataQuickPickItem<T>[] | undefined
            >
            while (true) {
                const { value, done } = await iterator.next()
                if (value) {
                    this.appendItems(value)
                }
                if (done) {
                    break
                }
            }
        } else if (items instanceof Promise) {
            this.appendItems(await items)
        } else {
            this.appendItems(items)
        }

        picker.busy = false
        picker.enabled = true

        this.appendItems([])
    }

    /**
     * Clears the prompter, then loads new items. Will automatically attempt to select the previously
     * selected items. This is a combination of {@link QuickPickPrompter.loadItems loadItems} and
     * {@link QuickPickPrompter.clearItems clearItems}.
     *
     * @param items Items to load
     * @returns Promise that is resolved upon completion
     */
    public async clearAndLoadItems(items: Promise<DataQuickPickItem<T>[]> | DataQuickPickItem<T>[]): Promise<void> {
        const previousSelected = [...this.quickPick.activeItems]
        this.clearItems()
        await this.loadItems(items)
        this.selectItems(...previousSelected)
    }

    protected async promptUser(): Promise<PromptResult<T>> {
        await this.setEstimatorHook()
        const choices = await promptUser(this.quickPick, this.onDidShowEmitter)
        this.onDidShowEmitter.dispose()

        if (choices === undefined) {
            return choices
        }

        this._lastPicked = choices[0]
        const result = choices[0].data

        return result instanceof Function ? await result() : result
    }

    public setLastResponse(picked: T | DataQuickPickItem<T> | undefined): void {
        // TODO: figure out how to recover from implicit responses
        if (picked === undefined) {
            return
        } else if (!isDataQuickPickItem(picked)) {
            const recovered = recoverItemFromData(picked, this.quickPick.items)
            this.quickPick.activeItems = this.quickPick.items.filter(item => item.label === recovered?.label)
        } else {
            this.quickPick.activeItems = this.quickPick.items.filter(item => item.label === picked.label)
        }

        if (this.options.showSelectedPreviously) {
            this.quickPick.activeItems.forEach(item => (item.detail = `${item.detail ?? ''} (${selectedPreviously})`))
            this.quickPick.items = [...this.quickPick.items]
        }

        if (this.quickPick.activeItems.length === 0) {
            this.quickPick.activeItems = [this.quickPick.items[0]]
        }
    }

    public setStepEstimator(estimator: StepEstimator<T>): void {
        this._estimator = estimator
    }

    private async setEstimatorHook(): Promise<void> {
        if (this._estimator === undefined) {
            return
        }

        function hashItem(item: DataQuickPickItem<any>): string {
            return `${item.label}:${item.description ?? ''}:${item.detail ?? ''}`
        }

        const estimates = new Map<string, number>()

        const setEstimate = (item: DataQuickPickItem<T>) => {
            if (item.skipEstimate) {
                return
            }

            if (item.data instanceof Function) {
                return item
                    .data()
                    .then(data => this.applyTransforms(data))
                    .then(result => this._estimator!(result))
                    .then(estimate => estimates.set(hashItem(item), estimate))
            } else {
                const transformed = this.applyTransforms(item.data)
                const estimate = this._estimator!(transformed)
                estimates.set(hashItem(item), estimate)
            }
        }

        const promises = this.quickPick.items.map(setEstimate)

        const current: number = this.quickPick.step!
        const total: number = this.quickPick.totalSteps!

        this.quickPick.onDidChangeActive(async active => {
            if (active.length === 0) {
                return
            }

            const sets = active.filter(item => !estimates.has(hashItem(item))).map(setEstimate)
            await sets[0]
            const estimate = estimates.get(hashItem(active[0])) ?? 0
            this.setSteps(current, total + estimate)
        })

        // We await the first promise before returning to guarantee that there is no 'stutter'
        // when showing the current/total step numbers
        if (promises.length > 0) {
            await promises[0]
            this.setSteps(current, total + estimates.get(hashItem(this.quickPick.items[0]))!)
        }
    }
}

/**
 * Allows the prompter to accept the QuickPick filter box as input, shown as a QuickPickItem.
 *
 * It is recommended to use `createQuickPick` instead of instantiating this class in isolation.
 *
 * @param label The label of the QuickPickItem that shows the user's input
 * @param transform Required when the expected type is not a string, transforming the input into the expected type or a control signal.
 */
export class FilterBoxQuickPickPrompter<T> extends QuickPickPrompter<T> {
    private onChangeValue?: vscode.Disposable

    public set lastResponse(response: DataQuickPickItem<T> | undefined) {
        if (this.isUserInput(response)) {
            this.quickPick.value = response.description ?? ''
        } else {
            super.lastResponse = response
        }
    }

    constructor(quickPick: DataQuickPick<T>, private readonly settings: FilterBoxInputSettings<T>) {
        super(quickPick)

        this.transform(selection => {
            if ((selection as T | typeof CUSTOM_USER_INPUT) === CUSTOM_USER_INPUT) {
                return settings.transform(quickPick.value) ?? selection
            }
            return selection
        })
    }

    public async loadItems(items: Promise<DataQuickPickItem<T>[]> | DataQuickPickItem<T>[]): Promise<void> {
        if (this.onChangeValue) {
            this.onChangeValue.dispose()
        }

        await super.loadItems(items)
        this.addFilterBoxInput()
    }

    private addFilterBoxInput(): void {
        const picker = this.quickPick as DataQuickPick<T | symbol>
        const validator = (input: string) =>
            this.settings.validator !== undefined ? this.settings.validator(input) : undefined
        const items = picker.items.filter(item => item.data !== CUSTOM_USER_INPUT)
        const { label } = this.settings

        function update(value: string = '') {
            if (value !== '') {
                const customUserInputItem = {
                    label,
                    description: value,
                    alwaysShow: true,
                    data: CUSTOM_USER_INPUT,
                    invalidSelection: validator(value) !== undefined,
                    detail: validator(value),
                } as DataQuickPickItem<T | symbol>

                picker.items = [customUserInputItem, ...items]
            } else {
                picker.items = items
            }
        }

        this.onChangeValue = picker.onDidChangeValue(update)
        update(picker.value)
    }

    private isUserInput(picked: any): picked is DataQuickPickItem<symbol> {
        return picked !== undefined && picked.data === CUSTOM_USER_INPUT
    }
}
