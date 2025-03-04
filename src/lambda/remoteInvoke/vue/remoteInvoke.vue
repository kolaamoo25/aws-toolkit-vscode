/*! * Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved. * SPDX-License-Identifier: Apache-2.0 */

<template>
    <h1>Invoke function {{ initialData.FunctionName }}</h1>
    <div id="app">
        <p style="margin-bottom: 5px; margin-top: 0; margin-right: 5px">ARN: {{ initialData.FunctionArn }}</p>

        <p style="margin-top: 0">Region: {{ initialData.FunctionRegion }}</p>

        <h3>Select a file to use as payload:</h3>
        <div>
            <button v-on:click="promptForFileLocation">Choose File</button>
            &nbsp; {{ selectedFile }}
        </div>
        <br />
        <h3>Or, use a sample request payload from a template:</h3>
        <select v-model="selectedSampleRequest" v-on:change="newSelection">
            <option disabled value="">Select an example input</option>
            <option v-for="item in initialData.InputSamples" :key="item" :value="item.filename">
                {{ item.name }}
            </option>
        </select>
        <br />
        <br />
        <textarea rows="20" cols="90" v-model="sampleText"></textarea>
        <br />
        <input type="submit" v-on:click="sendInput" value="Invoke" />
        <br />
    </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { WebviewClientFactory } from '../../../webviews/client'
import saveData from '../../../webviews/mixins/saveData'
import { RemoteInvokeData, RemoteInvokeWebview } from '../../commands/invokeLambda'

const client = WebviewClientFactory.create<RemoteInvokeWebview>()
const defaultInitialData = {
    FunctionName: '',
    FunctionArn: '',
    FunctionRegion: '',
    InputSamples: [],
}

export default defineComponent({
    async created() {
        this.initialData = (await client.init()) ?? this.initialData
    },
    data(): RemoteInvokeData {
        return {
            initialData: { ...defaultInitialData },
            selectedSampleRequest: '',
            sampleText: '',
            error: undefined,
            payload: {},
            statusCode: '',
            logs: '',
            showResponse: false,
            isLoading: false,
            selectedFile: '',
        }
    },
    mounted() {
        this.$nextTick(function () {
            window.addEventListener('message', this.handleMessageReceived)
        })
    },
    methods: {
        newSelection: function () {
            client.handler({
                command: 'sampleRequestSelected',
                requestName: this.selectedSampleRequest,
            })
        },
        promptForFileLocation: function () {
            client.handler({
                command: 'promptForFile',
            })
        },
        handleMessageReceived: function (event: any) {
            const message = event.data
            switch (message.command) {
                case 'loadedSample':
                    this.loadSampleText(message.sample)
                    this.selectedFile = message.selectedFile
                    break
                case 'invokedLambda':
                    this.showResponse = true
                    this.error = undefined
                    this.payload = ''
                    this.statusCode = ''
                    this.logs = ''
                    if (message.error) {
                        this.error = message.error
                    } else {
                        let parsed
                        try {
                            parsed = JSON.parse(message.payload)
                        } catch (e) {
                            parsed = message.payload
                        }
                        this.payload = parsed
                        this.statusCode = message.statusCode
                        this.logs = message.logs
                    }
                    this.isLoading = false
                    break
            }
        },
        loadSampleText: function (txt: string) {
            this.sampleText = txt
        },
        sendInput: function () {
            this.isLoading = true
            client.handler({
                command: 'invokeLambda',
                region: this.initialData.FunctionRegion,
                functionArn: this.initialData.FunctionArn,
                functionName: this.initialData.FunctionName,
                json: this.sampleText,
            })
        },
    },
    mixins: [saveData],
})
</script>
