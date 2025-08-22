#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = __importDefault(require("ws"));
const readline_1 = __importDefault(require("readline"));
const uuid_1 = require("uuid");
const defaultUrl = 'wss://47x76g6x-8080.inc1.devtunnels.ms/';
const serverWsUrlBase = process.argv[2] || defaultUrl;
const sessionId = `cli-session-${(0, uuid_1.v4)()}`;
const userId = `cli-user-${(0, uuid_1.v4)().substring(0, 8)}`;
if (!serverWsUrlBase || (!serverWsUrlBase.startsWith('ws://') && !serverWsUrlBase.startsWith('wss://'))) {
    console.error(`Error: Invalid WebSocket URL provided: "${serverWsUrlBase}"`);
    console.error('Please provide the full URL including ws:// or wss:// as the first argument.');
    console.error(`Example: ts-node test_cli.ts wss://your-tunnel-url.devtunnels.ms`);
    process.exit(1);
}
const wsUrl = `${serverWsUrlBase.replace(/\/$/, '')}/${sessionId}`;
console.log(`Connecting to : ${wsUrl}`);
console.log(`Using User ID : ${userId}`);
console.log(`Using Session ID: ${sessionId}`);
console.log('------------------------------------------');
console.log('Type your message and press Enter.');
console.log('Type "/exit" to quit.');
console.log('------------------------------------------');
const singleActionQuery = "Fetch my active deals.";
const multiActionQuery = "Find all active deals under the 'Big Deals Q3' campaign, then send an email to the primary contacts of those deals summarizing the deal stage and next steps. Also, create a follow-up task for me for each of these deals for next Monday.";
let ws;
try {
    ws = new ws_1.default(wsUrl);
}
catch (err) {
    console.error(`\nFATAL: Error creating WebSocket connection: ${err.message}`);
    process.exit(1);
}
let lastPresentedAction = null;
const markdownBuffer = new Map();
const conversationalBuffer = new Map();
let pendingParameterCollection = null;
const rl = readline_1.default.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'YOU> ',
});
ws.on('open', () => {
    console.log('\n[WebSocket opened]');
    const initMessage = { type: 'init', userId: userId };
    try {
        const initPayload = JSON.stringify(initMessage);
        ws.send(initPayload);
        console.log(`[Sent init]   : ${initPayload}`);
    }
    catch (e) {
        console.error(`[Error] Failed to send init message: ${e.message}`);
        ws.close();
        rl.close();
    }
    rl.prompt();
});
ws.on('message', (data) => {
    console.log('\nSERVER> ');
    let message;
    try {
        message = JSON.parse(data.toString());
        if (message.type === 'markdown_artefact_segment' && message.content?.segment?.segment) {
            const msgId = message.messageId;
            if (msgId) {
                const currentContent = markdownBuffer.get(msgId) || '';
                markdownBuffer.set(msgId, currentContent + message.content.segment.segment);
            }
            rl.prompt();
            return;
        }
        if (message.type === 'conversational_text_segment' && message.content?.segment?.segment) {
            const msgId = message.messageId;
            if (msgId) {
                const currentContent = conversationalBuffer.get(msgId) || '';
                conversationalBuffer.set(msgId, currentContent + message.content.segment.segment);
            }
            rl.prompt();
            return;
        }
        if (message.type === 'stream_end' && message.messageId) {
            const msgId = message.messageId;
            if (message.streamType === 'markdown_artefact') {
                const fullMarkdown = markdownBuffer.get(msgId);
                if (fullMarkdown) {
                    console.log('\n--- Markdown Artefact ---');
                    console.log(fullMarkdown);
                    console.log('-------------------------');
                    markdownBuffer.delete(msgId);
                }
            }
            else if (message.streamType === 'conversational') {
                const fullText = conversationalBuffer.get(msgId);
                if (fullText) {
                    console.log('\n--- Assistant Response ---');
                    console.log(fullText);
                    console.log('--------------------------');
                    conversationalBuffer.delete(msgId);
                }
            }
        }
        console.log(JSON.stringify(message, null, 2));
        if (message.type === 'parameter_collection_required' && message.content?.actions?.length > 0) {
            const action = message.content.actions[0];
            if (action.status === 'ready' && (!action.missingParameters || action.missingParameters.length === 0)) {
                lastPresentedAction = {
                    id: action.id,
                    toolName: action.toolName,
                    parameters: action.parameters
                };
                console.log(`\n[ACTION READY FOR CONFIRMATION]`);
                console.log(`  Tool: ${action.toolName}`);
                const args = action.parameters.filter((p) => p.currentValue !== undefined)
                    .reduce((obj, p) => ({ ...obj, [p.name]: p.currentValue }), {});
                console.log(`  Arguments: ${JSON.stringify(args, null, 2)}`);
                console.log(`  To execute, type: execute ${action.id}`);
                pendingParameterCollection = null;
            }
            else if (action.status === 'collecting_parameters' && action.missingParameters?.length > 0) {
                console.log(`\n[PARAMETER COLLECTION REQUIRED]`);
                console.log(`  Action: ${action.toolName}`);
                console.log(`  Assistant asks: ${action.description}`);
                pendingParameterCollection = {
                    actionId: action.id,
                    missingParams: [...action.missingParameters],
                    currentParamIndex: 0,
                    description: action.description,
                    allParams: action.parameters
                };
                lastPresentedAction = null;
                promptForNextParameter();
            }
        }
        else if (message.type === 'parameter_updated' && message.content) {
            const updatedAction = message.content;
            if (pendingParameterCollection && updatedAction.id === pendingParameterCollection.actionId && updatedAction.status === 'collecting_parameters' && updatedAction.missingParameters?.length > 0) {
                pendingParameterCollection.missingParams = [...updatedAction.missingParameters];
                pendingParameterCollection.currentParamIndex = 0;
                promptForNextParameter();
            }
            else if (updatedAction.status === 'ready') {
                console.log(`\n[INFO] Parameters collected. Action '${updatedAction.toolName}' (ID: ${updatedAction.id}) is now ready.`);
                console.log(`  To execute, type: execute ${updatedAction.id}`);
                lastPresentedAction = { id: updatedAction.id, toolName: updatedAction.toolName, parameters: updatedAction.parameters };
                pendingParameterCollection = null;
            }
        }
    }
    catch (e) {
        console.log(data.toString());
    }
    rl.prompt();
});
function promptForNextParameter() {
    if (pendingParameterCollection && pendingParameterCollection.currentParamIndex < pendingParameterCollection.missingParams.length) {
        const paramNameToCollect = pendingParameterCollection.missingParams[pendingParameterCollection.currentParamIndex];
        const paramDef = pendingParameterCollection.allParams.find(p => p.name === paramNameToCollect);
        const promptText = paramDef ? `Enter value for '${paramNameToCollect}' (${paramDef.description}): ` : `Enter value for '${paramNameToCollect}': `;
        rl.question(promptText, (value) => {
            if (ws.readyState === ws_1.default.OPEN && pendingParameterCollection) {
                const updateMsg = { type: 'update_parameter', content: { actionId: pendingParameterCollection.actionId, paramName: paramNameToCollect, value: value } };
                ws.send(JSON.stringify(updateMsg));
                console.log(`[Sent update_parameter for ${paramNameToCollect}]`);
                pendingParameterCollection.currentParamIndex++;
            }
        });
    }
    else if (pendingParameterCollection) {
        console.log(`[INFO] All listed parameters prompted. Waiting for server update...`);
        rl.prompt();
    }
}
ws.on('close', (code, reason) => {
    console.log(`\n[WebSocket closed] Code: ${code}, Reason: ${reason?.toString() || 'N/A'}`);
    rl.close();
    process.exit(0);
});
ws.on('error', (error) => {
    console.error(`\n[WebSocket error] Message: ${error.message}`);
    rl.close();
    process.exit(1);
});
rl.on('line', (line) => {
    const input = line.trim();
    if (input.toLowerCase() === '/exit') {
        console.log('Exiting...');
        ws.close();
        rl.close();
        return;
    }
    if (pendingParameterCollection && pendingParameterCollection.currentParamIndex < pendingParameterCollection.missingParams.length) {
        return;
    }
    if (input.toLowerCase() === '/single') {
        console.log(`Sending single action query: "${singleActionQuery}"`);
        if (ws.readyState === ws_1.default.OPEN) {
            ws.send(JSON.stringify({ content: singleActionQuery }));
        }
        else {
            console.log('[Info] WebSocket not open. Query not sent.');
        }
        rl.prompt();
        return;
    }
    if (input.toLowerCase() === '/multi') {
        console.log(`Sending multi-action query: "${multiActionQuery}"`);
        if (ws.readyState === ws_1.default.OPEN) {
            ws.send(JSON.stringify({ content: multiActionQuery }));
        }
        else {
            console.log('[Info] WebSocket not open. Query not sent.');
        }
        rl.prompt();
        return;
    }
    const executeMatch = input.match(/^execute\s+([a-zA-Z0-9_-]+(?:-[a-zA-Z0-9_-]+)*)$/);
    if (executeMatch) {
        const actionIdToExecute = executeMatch[1];
        if (lastPresentedAction && lastPresentedAction.id === actionIdToExecute) {
            if (ws.readyState === ws_1.default.OPEN) {
                const executeMessage = {
                    type: "execute_action",
                    content: {
                        actionId: actionIdToExecute
                    }
                };
                ws.send(JSON.stringify(executeMessage));
                console.log(`[Sent execute_action for ${actionIdToExecute}]`);
                lastPresentedAction = null;
            }
            else {
                console.log('[Info] WebSocket not open. Execute command not sent.');
            }
        }
        else {
            console.log(`[Info] No action with ID "${actionIdToExecute}" is pending confirmation, or ID mismatch.`);
        }
        rl.prompt();
        return;
    }
    if (ws.readyState === ws_1.default.OPEN) {
        const userMessage = { content: input };
        try {
            const payload = JSON.stringify(userMessage);
            ws.send(payload);
        }
        catch (e) {
            console.error(`[Error] Failed to send message: ${e.message}`);
        }
    }
    else {
        console.log('[Info] WebSocket not open. Message not sent.');
    }
});
rl.on('close', () => {
    console.log('\nReadline interface closed. Goodbye!');
    if (ws.readyState === ws_1.default.OPEN || ws.readyState === ws_1.default.CONNECTING) {
        ws.close();
    }
});
