/*!
 * Copyright 2018-2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import { Credentials } from 'aws-sdk'
import { env, QuickPickItem, Uri, ViewColumn, window } from 'vscode'
import { LoginManager } from '../credentials/loginManager'
import { asString, CredentialsId, fromString } from '../credentials/providers/credentials'
import { CredentialsProviderManager } from '../credentials/providers/credentialsProviderManager'
import { AwsContext } from './awsContext'
import { AwsContextTreeCollection } from './awsContextTreeCollection'
import * as extensionConstants from './constants'
import { getAccountId } from './credentials/accountId'
import { CredentialSelectionState } from './credentials/credentialSelectionState'
import {
    credentialProfileSelector,
    DefaultCredentialSelectionDataProvider,
    promptToDefineCredentialsProfile,
} from './credentials/defaultCredentialSelectionDataProvider'
import { UserCredentialsUtils } from './credentials/userCredentialsUtils'
import * as localizedText from './localizedText'
import { Region } from './regions/endpoints'
import { RegionProvider } from './regions/regionProvider'
import { getRegionsForActiveCredentials } from './regions/regionUtilities'
import { createQuickPick, promptUser } from './ui/picker'
import { SharedCredentialsProvider } from '../credentials/providers/sharedCredentialsProvider'
import { getIdeProperties } from './extensionUtilities'
import { credentialHelpUrl } from './constants'
import { showViewLogsMessage } from './utilities/messages'
import globals from './extensionGlobals'

export class DefaultAWSContextCommands {
    private readonly _awsContext: AwsContext
    private readonly _awsContextTrees: AwsContextTreeCollection
    private readonly _regionProvider: RegionProvider

    private readonly TITLE_HIDE_REGION = localize(
        'AWS.message.prompt.region.hide.title',
        'Select a region to hide from the {0} Explorer',
        getIdeProperties().company
    )
    private readonly TITLE_SHOW_REGION = localize(
        'AWS.message.prompt.region.show.title',
        'Select a region to show in the {0} Explorer',
        getIdeProperties().company
    )

    public constructor(
        awsContext: AwsContext,
        awsContextTrees: AwsContextTreeCollection,
        regionProvider: RegionProvider,
        private readonly loginManager: LoginManager
    ) {
        this._awsContext = awsContext
        this._awsContextTrees = awsContextTrees
        this._regionProvider = regionProvider
    }

    public async onCommandLogin() {
        const profileName = await this.getProfileNameFromUser()
        if (!profileName) {
            // user clicked away from quick pick or entered nothing
            return
        }

        await this.loginManager.login({ passive: false, providerId: fromString(profileName) })
    }

    public async onCommandCreateCredentialsProfile(): Promise<void> {
        const credentialsFiles: string[] = await UserCredentialsUtils.findExistingCredentialsFilenames()

        if (credentialsFiles.length === 0) {
            // Help user make a new credentials profile
            const profileName: string | undefined = await this.promptAndCreateNewCredentialsFile()

            if (profileName) {
                await this.loginManager.login({ passive: false, providerId: fromString(profileName) })
            }
        } else {
            await this.editCredentials()
        }
    }

    public async onCommandLogout() {
        await this.loginManager.logout()
    }

    public async onCommandShowRegion() {
        const explorerRegions = new Set(await this._awsContext.getExplorerRegions())
        const newRegion = await this.promptForFilteredRegion(
            candidateRegion => !explorerRegions.has(candidateRegion.id),
            this.TITLE_SHOW_REGION,
            { step: 1, totalSteps: 1 }
        )

        if (newRegion) {
            await this._awsContext.addExplorerRegion(newRegion)
            this.refresh()
        }
    }

    public async onCommandHideRegion(regionCode?: string) {
        const region =
            regionCode ||
            (await this.promptForRegion(await this._awsContext.getExplorerRegions(), this.TITLE_HIDE_REGION, {
                step: 1,
                totalSteps: 1,
            }))
        if (region) {
            await this._awsContext.removeExplorerRegion(region)
            this.refresh()
        }
    }

    private refresh() {
        this._awsContextTrees.refreshTrees()
    }

    /**
     * @description Ask user for credentials information, store
     * it in new credentials file.
     *
     * @returns The profile name, or undefined if user cancelled
     */
    private async promptAndCreateNewCredentialsFile(): Promise<string | undefined> {
        while (true) {
            const dataProvider = new DefaultCredentialSelectionDataProvider([], globals.context)
            const state: CredentialSelectionState = await promptToDefineCredentialsProfile(dataProvider)

            if (!state.profileName || !state.accesskey || !state.secretKey) {
                return undefined
            }

            // TODO : Get a region relevant to the partition for these credentials -- https://github.com/aws/aws-toolkit-vscode/issues/188
            const accountId = await getAccountId(new Credentials(state.accesskey, state.secretKey), 'us-east-1')

            if (accountId) {
                await UserCredentialsUtils.generateCredentialDirectoryIfNonexistent()
                await UserCredentialsUtils.generateCredentialsFile({
                    profileName: state.profileName,
                    accessKey: state.accesskey,
                    secretKey: state.secretKey,
                })

                const sharedProviderId: CredentialsId = {
                    credentialSource: SharedCredentialsProvider.getProviderType(),
                    credentialTypeId: state.profileName,
                }

                window.showInformationMessage(
                    localize(
                        'AWS.message.prompt.credentials.definition.done',
                        'Created {0} credentials profile: {1}',
                        getIdeProperties().company,
                        state.profileName
                    )
                )

                return asString(sharedProviderId)
            }

            const response = await showViewLogsMessage(
                localize(
                    'AWS.message.prompt.credentials.definition.tryAgain',
                    '{0} credentials appear invalid. Try again?',
                    getIdeProperties().company
                ),
                globals.window,
                'warn',
                [localizedText.yes, localizedText.no]
            )

            if (!response || response !== localizedText.yes) {
                return undefined
            }
        } // Keep asking until cancel or valid credentials are entered
    }

    /**
     * @description Responsible for getting a profile from the user,
     * working with them to define one if necessary.
     *
     * @returns User's selected Profile name, or undefined if none was selected.
     * undefined is also returned if we leave the user in a state where they are
     * editing their credentials file.
     */
    private async getProfileNameFromUser(): Promise<string | undefined> {
        const credentialsFiles: string[] = await UserCredentialsUtils.findExistingCredentialsFilenames()
        const providerMap = await CredentialsProviderManager.getInstance().getCredentialProviderNames()
        const profileNames = Object.keys(providerMap)
        if (profileNames.length > 0) {
            // There are credentials for the user to choose from
            const dataProvider = new DefaultCredentialSelectionDataProvider(profileNames, globals.context)
            const state = await credentialProfileSelector(dataProvider)
            if (state && state.credentialProfile) {
                return state.credentialProfile.label
            }
        } else if (credentialsFiles.length === 0) {
            if (await this.promptCredentialsSetup()) {
                return await this.promptAndCreateNewCredentialsFile()
            }
        } else {
            if (await this.promptCredentialsSetup()) {
                await this.editCredentials()
            }
        }
        return undefined
    }

    private async promptCredentialsSetup(): Promise<boolean> {
        // If no credentials were found, the user should be
        // encouraged to define some.
        const userResponse = await window.showInformationMessage(
            localize(
                'AWS.message.prompt.credentials.create',
                'No {0} credentials found. Create one now?',
                getIdeProperties().company
            ),
            localizedText.yes,
            localizedText.no,
            localizedText.help
        )

        if (userResponse === localizedText.yes) {
            return true
        } else if (userResponse === localizedText.help) {
            env.openExternal(Uri.parse(credentialHelpUrl))
            return await this.promptCredentialsSetup()
        }

        return false
    }

    /**
     * @description Sets the user up to edit the credentials files.
     */
    private async editCredentials(): Promise<void> {
        const credentialsFiles: string[] = await UserCredentialsUtils.findExistingCredentialsFilenames()
        let preserveFocus: boolean = false
        let viewColumn: ViewColumn = ViewColumn.Active

        for (const filename of credentialsFiles) {
            await window.showTextDocument(Uri.file(filename), {
                preserveFocus: preserveFocus,
                preview: false,
                viewColumn: viewColumn,
            })

            preserveFocus = true
            viewColumn = ViewColumn.Beside
        }

        const response = await window.showInformationMessage(
            localize(
                'AWS.message.prompt.credentials.definition.help',
                'Editing an {0} credentials file.',
                getIdeProperties().company
            ),
            localizedText.viewDocs
        )

        if (response && response === localizedText.viewDocs) {
            await env.openExternal(Uri.parse(extensionConstants.aboutCredentialsFileUrl))
        }
    }

    /**
     * @description
     * Prompts the user to select a region.
     * The set shown to the user is filtered from all available regions.
     *
     * @param filter Filter to apply to the available regions
     */
    private async promptForFilteredRegion(
        filter: (region: Region) => boolean,
        title?: string,
        params?: { step: number; totalSteps: number }
    ): Promise<string | undefined> {
        const partitionRegions = getRegionsForActiveCredentials(this._awsContext, this._regionProvider)

        const regionsToShow = partitionRegions.filter(filter).map(r => r.id)

        return this.promptForRegion(regionsToShow, title, params)
    }

    /**
     * Prompts the user to select a region.
     *
     * @param regions (Optional) The regions to show the user. If none provided, all available
     * regions are shown. Regions provided must exist in the available regions to be shown.
     */
    private async promptForRegion(
        regions?: string[],
        title?: string,
        params?: { step?: number; totalSteps?: number }
    ): Promise<string | undefined> {
        const partitionRegions = getRegionsForActiveCredentials(this._awsContext, this._regionProvider)

        const regionsToShow = partitionRegions
            .filter(r => {
                if (regions) {
                    return regions.some(x => x === r.id)
                }

                return true
            })
            .map(r => ({
                label: r.name,
                detail: r.id,
            }))

        const picker = createQuickPick({
            options: {
                placeHolder: localize('AWS.message.selectRegion', 'Select an {0} region', getIdeProperties().company),
                title: title,
                matchOnDetail: true,
                step: params?.step,
                totalSteps: params?.totalSteps,
            },
            items: regionsToShow,
        })

        const response = await promptUser<QuickPickItem>({
            picker: picker,
        })

        if (response?.length === 1) {
            return response[0].detail
        }

        return undefined
    }
}
