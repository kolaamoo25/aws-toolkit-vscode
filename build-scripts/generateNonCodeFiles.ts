/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as child_process from 'child_process'
import * as fs from 'fs-extra'
import { marked } from 'marked'
import * as path from 'path'

// doesn't use path utils as this should be formatted for finding images with HTML markup
const REPO_ROOT = path.dirname(__dirname)

/**
 * replaces relative paths with an `!!EXTENSIONROOT!!` token.
 * This makes it easier to swap in relative links when the extension loads.
 * @param root Repository root
 * @param inputFile Input .md file to swap to HTML
 * @param outputFile Filepath to output HTML to
 * @param cn Converts "AWS" to "Amazon" for CN-based compute.
 */
function translateReadmeToHtml(root: string, inputFile: string, outputFile: string, cn: boolean = false) {
    const fileText = fs.readFileSync(path.join(root, inputFile)).toString()
    const relativePathRegex = /]\(\.\//g
    let transformedText = fileText.replace(relativePathRegex, '](!!EXTENSIONROOT!!/')
    if (cn) {
        transformedText = transformedText.replace(/AWS/g, 'Amazon').replace(/-en.png/g, '-cn.png')
    }

    marked.parse(transformedText, (err, result) => {
        fs.writeFileSync(path.join(root, outputFile), result)
    })
}

/**
 * Do a best effort job of generating a git hash and putting it into the package
 */
function generateFileHash(root: string) {
    try {
        const response = child_process.execSync('git rev-parse HEAD')
        fs.outputFileSync(path.join(root, '.gitcommit'), response)
    } catch (e) {
        console.log(`Getting commit hash failed ${e}`)
    }
}

translateReadmeToHtml(REPO_ROOT, 'README.quickstart.vscode.md', 'quickStartVscode.html')
translateReadmeToHtml(REPO_ROOT, 'README.quickstart.cloud9.md', 'quickStartCloud9.html')
translateReadmeToHtml(REPO_ROOT, 'README.quickstart.cloud9.md', 'quickStartCloud9-cn.html', true)
generateFileHash(REPO_ROOT)
