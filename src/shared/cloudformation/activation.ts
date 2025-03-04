/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { getLogger } from '../logger'
import { localize } from '../utilities/vsCodeUtils'

import { CloudFormationTemplateRegistry } from './templateRegistry'
import { getIdeProperties } from '../extensionUtilities'
import { NoopWatcher } from '../watchedFiles'
import { createStarterTemplateFile } from './cloudformation'
import globals from '../extensionGlobals'

export const TEMPLATE_FILE_GLOB_PATTERN = '**/*.{yaml,yml}'

/**
 * Match any file path that contains a .aws-sam folder. The way this works is:
 * match anything that starts  with a '/' or '\', then '.aws-sam', then either
 * a '/' or '\' followed by any number of characters or end of a string (so it
 * matches both /.aws-sam or /.aws-sam/<any number of characters>)
 */
export const TEMPLATE_FILE_EXCLUDE_PATTERN = /.*[/\\]\.aws-sam([/\\].*|$)/

/**
 * Creates a CloudFormationTemplateRegistry which retains the state of CloudFormation templates in a workspace.
 * This also assigns a FileSystemWatcher which will update the registry on any change to tracked templates.
 *
 * @param extensionContext VS Code extension context
 */
export async function activate(extensionContext: vscode.ExtensionContext): Promise<void> {
    try {
        const registry = new CloudFormationTemplateRegistry()
        globals.templateRegistry = registry
        await registry.addExcludedPattern(TEMPLATE_FILE_EXCLUDE_PATTERN)
        await registry.addWatchPattern(TEMPLATE_FILE_GLOB_PATTERN)
    } catch (e) {
        vscode.window.showErrorMessage(
            localize(
                'AWS.codelens.failToInitialize',
                'Failed to activate template registry. {0}} will not appear on SAM template files.',
                getIdeProperties().codelenses
            )
        )
        getLogger().error('Failed to activate template registry', e)
        // This prevents us from breaking for any reason later if it fails to load. Since
        // Noop watcher is always empty, we will get back empty arrays with no issues.
        globals.templateRegistry = new NoopWatcher() as unknown as CloudFormationTemplateRegistry
    }
    // If setting it up worked, add it to subscriptions so it is cleaned up at exit
    extensionContext.subscriptions.push(
        globals.templateRegistry,
        vscode.commands.registerCommand('aws.cloudFormation.newTemplate', () => createStarterTemplateFile(false)),
        vscode.commands.registerCommand('aws.sam.newTemplate', () => createStarterTemplateFile(true))
    )
}
