#!/usr/bin/env node

import WebSocket from 'ws';
import readline from 'readline';
import { v4 as uuidv4 } from 'uuid';

// --- Configuration ---
// Get server URL from command line argument or use default
const defaultUrl = 'wss://47x76g6x-8080.inc1.devtunnels.ms/'; // YOUR DEV TUNNEL URL HERE
const serverWsUrlBase = process.argv[2] || defaultUrl;

// --- User/Session Info ---
const sessionId = `cli-session-${uuidv4()}`; // Generate unique session ID for this run
const userId = `cli-user-${uuidv4().substring(0, 8)}`; // Generate unique-ish user ID

// --- Validate and Construct URL ---
if (!serverWsUrlBase || (!serverWsUrlBase.startsWith('ws://') && !serverWsUrlBase.startsWith('wss://'))) {
    console.error(`Error: Invalid WebSocket URL provided: "${serverWsUrlBase}"`);
    console.error('Please provide the full URL including ws:// or wss:// as the first argument.');
    console.error(`Example: ts-node test_cli.ts wss://your-tunnel-url.devtunnels.ms`);
    process.exit(1);
}
// Ensure no trailing slash and append sessionId
const wsUrl = `${serverWsUrlBase.replace(/\/$/, '')}/${sessionId}`;

// --- WebSocket Connection & Readline Setup ---
console.log(`Connecting to : ${wsUrl}`);
console.log(`Using User ID : ${userId}`);
console.log(`Using Session ID: ${sessionId}`);
console.log('------------------------------------------');
console.log('Type your message and press Enter.');
console.log('Type "/exit" to quit.');
console.log('------------------------------------------');

// --- Test Queries ---
const singleActionQuery = "Fetch my active deals.";
const multiActionQuery = "Find all active deals under the 'Big Deals Q3' campaign, then send an email to the primary contacts of those deals summarizing the deal stage and next steps. Also, create a follow-up task for me for each of these deals for next Monday.";

let ws: WebSocket;
try {
    ws = new WebSocket(wsUrl);
} catch (err: any) {
    console.error(`\nFATAL: Error creating WebSocket connection: ${err.message}`);
    process.exit(1);
}

// --- State for Action Confirmation ---
let lastPresentedAction: { id: string; toolName: string; parameters: Array<{name: string, currentValue?: any}> } | null = null;

// --- State for Markdown Buffering ---
const markdownBuffer: Map<string, string> = new Map(); // Map<messageId, accumulatedMarkdown>
const conversationalBuffer: Map<string, string> = new Map(); // Map<messageId, accumulatedConversationalText>

let pendingParameterCollection: { actionId: string; missingParams: string[]; currentParamIndex: number; description: string, allParams: Array<{name: string, description: string, currentValue?: any}> } | null = null;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'YOU> ',
});

// --- WebSocket Event Handlers ---

ws.on('open', () => {
    console.log('\n[WebSocket opened]');
    // Send the initialization message
    const initMessage = { type: 'init', userId: userId };
    try {
        const initPayload = JSON.stringify(initMessage);
        ws.send(initPayload);
        console.log(`[Sent init]   : ${initPayload}`);
    } catch (e: any) {
        console.error(`[Error] Failed to send init message: ${e.message}`);
        ws.close(); // Close connection if init fails
        rl.close();
    }
    // Start the prompt loop
    rl.prompt();
});

ws.on('message', (data) => {
    console.log('\nSERVER> '); // Newline before server message
    let message;
    try {
        message = JSON.parse(data.toString());
        // Pretty print JSON for readability
        // console.log(JSON.stringify(message, null, 2)); // Temporarily disable raw print

        // --- Handle Markdown Artefact Streaming ---
        if (message.type === 'markdown_artefact_segment' && message.content?.segment?.segment) {
            const msgId = message.messageId;
            if (msgId) {
                const currentContent = markdownBuffer.get(msgId) || '';
                markdownBuffer.set(msgId, currentContent + message.content.segment.segment);
            }
            // Don't print yet, wait for stream_end
            rl.prompt(); // Keep prompt active
            return; // Stop processing this chunk here
        }

        // --- Handle Conversational Text Streaming (Optional, but good for consistency) ---
         if (message.type === 'conversational_text_segment' && message.content?.segment?.segment) {
            const msgId = message.messageId;
            if (msgId) {
                const currentContent = conversationalBuffer.get(msgId) || '';
                conversationalBuffer.set(msgId, currentContent + message.content.segment.segment);
            }
            // Don't print yet, wait for stream_end
            rl.prompt(); // Keep prompt active
            return; // Stop processing this chunk here
        }

        // --- Handle Stream End ---
        if (message.type === 'stream_end' && message.messageId) {
            const msgId = message.messageId;
            if (message.streamType === 'markdown_artefact') {
                const fullMarkdown = markdownBuffer.get(msgId);
                if (fullMarkdown) {
                    console.log('\n--- Markdown Artefact ---');
                    console.log(fullMarkdown);
                    console.log('-------------------------');
                    markdownBuffer.delete(msgId); // Clear buffer
                }
            } else if (message.streamType === 'conversational') {
                 const fullText = conversationalBuffer.get(msgId);
                 if (fullText) {
                     console.log('\n--- Assistant Response ---');
                     console.log(fullText);
                     console.log('--------------------------');
                     conversationalBuffer.delete(msgId); // Clear buffer
                 }
            }
            // Continue processing other stream_end types or fall through
        }

        // --- Handle Other Message Types (Print them) ---
        // Print any message type that wasn't buffered or handled above
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
                const args = action.parameters.filter((p: any) => p.currentValue !== undefined)
                                             .reduce((obj: any, p: any) => ({...obj, [p.name]: p.currentValue}), {});
                console.log(`  Arguments: ${JSON.stringify(args, null, 2)}`);
                console.log(`  To execute, type: execute ${action.id}`);
                pendingParameterCollection = null; // Clear any pending collection
            } else if (action.status === 'collecting_parameters' && action.missingParameters?.length > 0) {
                console.log(`\n[PARAMETER COLLECTION REQUIRED]`);
                console.log(`  Action: ${action.toolName}`);
                console.log(`  Assistant asks: ${action.description}`);
                pendingParameterCollection = {
                    actionId: action.id,
                    missingParams: [...action.missingParameters], // Clone array
                    currentParamIndex: 0,
                    description: action.description,
                    allParams: action.parameters // Store all params for descriptions
                };
                lastPresentedAction = null; // Clear any pending direct execution
                promptForNextParameter();
            }
        } else if (message.type === 'parameter_updated' && message.content) {
            const updatedAction = message.content;
            // If still collecting, prompt for next. If ready, it will be handled by the 'parameter_collection_required' logic if server resends it, or CLI can check status here.
            if (pendingParameterCollection && updatedAction.id === pendingParameterCollection.actionId && updatedAction.status === 'collecting_parameters' && updatedAction.missingParameters?.length > 0) {
                pendingParameterCollection.missingParams = [...updatedAction.missingParameters];
                pendingParameterCollection.currentParamIndex = 0; // Reset index to find next missing
                promptForNextParameter();
            } else if (updatedAction.status === 'ready') {
                // Server might send a 'parameter_collection_required' again, or we can handle it here.
                // For simplicity, let's assume server resends 'parameter_collection_required' when ready.
                // Or, we can directly set lastPresentedAction and prompt for execution.
                console.log(`\n[INFO] Parameters collected. Action '${updatedAction.toolName}' (ID: ${updatedAction.id}) is now ready.`);
                console.log(`  To execute, type: execute ${updatedAction.id}`);
                lastPresentedAction = { id: updatedAction.id, toolName: updatedAction.toolName, parameters: updatedAction.parameters };
                pendingParameterCollection = null;
            }
        }
    } catch (e: any) {
        // If not JSON, print raw string
        console.log(data.toString());
    }
    // Re-prompt user after receiving message
    rl.prompt();
});

function promptForNextParameter() {
    if (pendingParameterCollection && pendingParameterCollection.currentParamIndex < pendingParameterCollection.missingParams.length) {
        const paramNameToCollect = pendingParameterCollection.missingParams[pendingParameterCollection.currentParamIndex];
        const paramDef = pendingParameterCollection.allParams.find(p => p.name === paramNameToCollect);
        const promptText = paramDef ? `Enter value for '${paramNameToCollect}' (${paramDef.description}): ` : `Enter value for '${paramNameToCollect}': `;
        rl.question(promptText, (value) => {
            if (ws.readyState === WebSocket.OPEN && pendingParameterCollection) {
                const updateMsg = { type: 'update_parameter', content: { actionId: pendingParameterCollection.actionId, paramName: paramNameToCollect, value: value } };
                ws.send(JSON.stringify(updateMsg));
                console.log(`[Sent update_parameter for ${paramNameToCollect}]`);
                pendingParameterCollection.currentParamIndex++; // Move to next, or wait for server response to re-trigger promptForNextParameter
                // rl.prompt(); // Prompt is handled by server message response
            }
        });
    } else if (pendingParameterCollection) { // All listed missing params have been prompted for
        console.log(`[INFO] All listed parameters prompted. Waiting for server update...`);
        // Server will send 'parameter_updated'. If it's ready, it will trigger the confirmation flow.
        // If still collecting (e.g. conditional params), it will re-trigger parameter collection.
        rl.prompt();
    }
}

ws.on('close', (code, reason) => {
    console.log(`\n[WebSocket closed] Code: ${code}, Reason: ${reason?.toString() || 'N/A'}`);
    rl.close(); // Close readline interface
    process.exit(0); // Exit script cleanly
});

ws.on('error', (error) => {
    console.error(`\n[WebSocket error] Message: ${error.message}`);
    rl.close();
    process.exit(1); // Exit script with error code
});

// --- Readline Event Handler ---

rl.on('line', (line) => {
    const input = line.trim();
    if (input.toLowerCase() === '/exit') {
        console.log('Exiting...');
        ws.close(); // Initiate graceful close
        rl.close();
        return;
    }

    // If currently collecting parameters, this input is for the pending parameter
    if (pendingParameterCollection && pendingParameterCollection.currentParamIndex < pendingParameterCollection.missingParams.length) {
        // The rl.question callback handles sending the update_parameter message.
        // We just need to avoid processing this as a new command.
        // The prompt will be re-issued by promptForNextParameter or after server response.
        return; 
    }

    // Add commands for predefined queries
    if (input.toLowerCase() === '/single') {
        console.log(`Sending single action query: "${singleActionQuery}"`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ content: singleActionQuery }));
        } else {
            console.log('[Info] WebSocket not open. Query not sent.');
        }
        rl.prompt();
        return;
    }

    if (input.toLowerCase() === '/multi') {
        console.log(`Sending multi-action query: "${multiActionQuery}"`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ content: multiActionQuery }));
        } else {
            console.log('[Info] WebSocket not open. Query not sent.');
        }
        rl.prompt();
        return;
    }
    // Check for execute command
    const executeMatch = input.match(/^execute\s+([a-zA-Z0-9_-]+(?:-[a-zA-Z0-9_-]+)*)$/); // Matches "execute <uuid-like-id>"
    if (executeMatch) {
        const actionIdToExecute = executeMatch[1];
        if (lastPresentedAction && lastPresentedAction.id === actionIdToExecute) {
            if (ws.readyState === WebSocket.OPEN) {
                const executeMessage = {
                    type: "execute_action",
                    content: {
                        actionId: actionIdToExecute
                    }
                };
                ws.send(JSON.stringify(executeMessage));
                console.log(`[Sent execute_action for ${actionIdToExecute}]`);
                lastPresentedAction = null; // Clear the pending action
            } else {
                console.log('[Info] WebSocket not open. Execute command not sent.');
            }
        } else {
            console.log(`[Info] No action with ID "${actionIdToExecute}" is pending confirmation, or ID mismatch.`);
        }
        rl.prompt();
        return;
    }

    if (ws.readyState === WebSocket.OPEN) {
        // Send user message as content
        const userMessage = { content: input };
        try {
            const payload = JSON.stringify(userMessage);
            ws.send(payload);
            // console.log(`[Sent message]: ${payload}`); // Optional: log sent message
        } catch (e: any) {
            console.error(`[Error] Failed to send message: ${e.message}`);
            // Don't re-prompt immediately on send error, wait for potential WS error/close
        }
    } else {
        console.log('[Info] WebSocket not open. Message not sent.');
        // Don't re-prompt if not open, wait for close/error event
    }
    // Prompt is handled by the 'message' event handler after server response
    // rl.prompt(); // DO NOT re-prompt here
});

rl.on('close', () => {
    console.log('\nReadline interface closed. Goodbye!');
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(); // Ensure WS is closed if readline closes unexpectedly
    }
    // process.exit(0); // Exit is handled by ws.on('close')
});