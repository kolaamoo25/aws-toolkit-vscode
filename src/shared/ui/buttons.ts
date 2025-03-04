/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as nls from 'vscode-nls'
import { documentationUrl } from '../constants'
import globals from '../extensionGlobals'
import { WizardControl, WIZARD_EXIT, WIZARD_RETRY } from '../wizards/wizard'

const localize = nls.loadMessageBundle()
const HELP_TOOLTIP = localize('AWS.command.help', 'View Toolkit Documentation')

type WizardButton<T> = QuickInputButton<T | WizardControl> | QuickInputButton<void>
export type PrompterButtons<T> = readonly WizardButton<T>[]

/** Light wrapper around VS Code's buttons, adding a `onClick` callback. */
export interface QuickInputButton<T> extends vscode.QuickInputButton {
    onClick?: () => T
}

/**
 * Creates a QuickInputButton with a predefined help button (dark and light theme compatible)
 * Images are only loaded after extension.ts loads; this should happen on any user-facing extension usage.
 * button will exist regardless of image loading (UI tests will still see this)
 *
 * @param uri Opens the URI upon clicking
 * @param tooltip Optional tooltip for button
 * @param url Optional URL to open when button is clicked
 */
export function createHelpButton(
    uri: string | vscode.Uri = documentationUrl,
    tooltip: string = HELP_TOOLTIP
): QuickInputLinkButton {
    const iconPath = {
        light: vscode.Uri.file(globals.iconPaths.light.help),
        dark: vscode.Uri.file(globals.iconPaths.dark.help),
    }

    return new QuickInputLinkButton(uri, iconPath, tooltip)
}

export class QuickInputLinkButton implements QuickInputButton<void> {
    public readonly uri: vscode.Uri

    constructor(
        link: string | vscode.Uri,
        public readonly iconPath: vscode.QuickInputButton['iconPath'],
        public readonly tooltip?: string
    ) {
        this.uri = typeof link === 'string' ? vscode.Uri.parse(link) : link
    }

    public onClick(): void {
        vscode.env.openExternal(this.uri)
    }
}

type ButtonState = 'on' | 'off'
interface ToggleButtonOptions {
    initState?: ButtonState
    onCallback?: () => void
    offCallBack?: () => void
}

/**
 * Basic toggle button. Swaps icons whenever clicked.
 */
export class QuickInputToggleButton implements QuickInputButton<WizardControl> {
    private _state: ButtonState

    public get iconPath(): vscode.QuickInputButton['iconPath'] {
        return this._state === 'on' ? this.onState.iconPath : this.offState.iconPath
    }

    public get tooltip(): string | undefined {
        return this._state === 'on' ? this.onState.tooltip : this.offState.tooltip
    }

    /** The current state of the button, either 'on' or 'off' */
    public get state(): ButtonState {
        return this._state
    }

    constructor(
        private readonly onState: vscode.QuickInputButton,
        private readonly offState: vscode.QuickInputButton,
        private readonly options: ToggleButtonOptions = {}
    ) {
        this._state = options?.initState ?? 'off'
    }

    public onClick(): WizardControl {
        this._state = this._state === 'on' ? 'off' : 'on'

        if (this._state === 'on' && this.options.onCallback !== undefined) {
            this.options.onCallback()
        }
        if (this._state === 'off' && this.options.offCallBack !== undefined) {
            this.options.offCallBack()
        }

        return WIZARD_RETRY
    }
}

// Currently VS Code uses a static back button for every QuickInput, so we can't redefine any of its
// properties without potentially affecting other extensions. Creating a wrapper is possible, but it
// would still need to be swapped out for the real Back button when adding it to the QuickInput.
export function createBackButton(): QuickInputButton<WizardControl> {
    return vscode.QuickInputButtons.Back as QuickInputButton<WizardControl>
}

export function createExitButton(): QuickInputButton<WizardControl> {
    return {
        iconPath: {
            light: globals.iconPaths.light.exit,
            dark: globals.iconPaths.dark.exit,
        },
        tooltip: localize('AWS.generic.exit', 'Exit'),
        onClick: () => WIZARD_EXIT,
    }
}

export function createRefreshButton(): QuickInputButton<void> {
    return {
        iconPath: {
            light: globals.iconPaths.light.refresh,
            dark: globals.iconPaths.dark.refresh,
        },
        tooltip: localize('AWS.generic.refresh', 'Refresh'),
    }
}

/** Creates a '+' button. Usually used to add new resources during a prompt. */
export function createPlusButton(tooltip?: string): QuickInputButton<void> {
    return {
        iconPath: {
            light: globals.iconPaths.light.plus,
            dark: globals.iconPaths.dark.plus,
        },
        tooltip,
    }
}

/**
 * Creates an array of buttons useful to most Quick Input prompts, especially in the context of a Wizard
 * Currently has: 'help', 'exit', and 'back'
 *
 * @param helpUri optional URI to link to for the 'help' button (see {@link createHelpButton} for defaults)
 * @returns An array of buttons
 */
export function createCommonButtons(helpUri?: string | vscode.Uri): PrompterButtons<WizardControl> {
    return [createHelpButton(helpUri), createBackButton(), createExitButton()]
}
