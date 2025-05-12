#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = __importDefault(require("ws"));
const readline_1 = __importDefault(require("readline"));
const uuid_1 = require("uuid");
// --- Configuration ---
// Get server URL from command line argument or use default
const defaultUrl = 'ws://localhost:3000'; // YOUR DEV TUNNEL URL HERE
const serverWsUrlBase = process.argv[2] || defaultUrl;
// --- User/Session Info ---
const sessionId = `cli-session-${(0, uuid_1.v4)()}`; // Generate unique session ID for this run
const userId = `cli-user-${(0, uuid_1.v4)().substring(0, 8)}`; // Generate unique-ish user ID
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
let ws;
try {
    ws = new ws_1.default(wsUrl);
}
catch (err) {
    console.error(`\nFATAL: Error creating WebSocket connection: ${err.message}`);
    process.exit(1);
}
const rl = readline_1.default.createInterface({
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
    }
    catch (e) {
        console.error(`[Error] Failed to send init message: ${e.message}`);
        ws.close(); // Close connection if init fails
        rl.close();
    }
    // Start the prompt loop
    rl.prompt();
});
ws.on('message', (data) => {
    console.log('\nSERVER> '); // Newline before server message
    try {
        const message = JSON.parse(data.toString());
        // Pretty print JSON for readability
        console.log(JSON.stringify(message, null, 2));
    }
    catch (e) {
        // If not JSON, print raw string
        console.log(data.toString());
    }
    // Re-prompt user after receiving message
    rl.prompt();
});
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
    if (ws.readyState === ws_1.default.OPEN) {
        // Send user message as content
        const userMessage = { content: input };
        try {
            const payload = JSON.stringify(userMessage);
            ws.send(payload);
            // console.log(`[Sent message]: ${payload}`); // Optional: log sent message
        }
        catch (e) {
            console.error(`[Error] Failed to send message: ${e.message}`);
            // Don't re-prompt immediately on send error, wait for potential WS error/close
        }
    }
    else {
        console.log('[Info] WebSocket not open. Message not sent.');
        // Don't re-prompt if not open, wait for close/error event
    }
    // Prompt is handled by the 'message' event handler after server response
    // rl.prompt(); // DO NOT re-prompt here
});
rl.on('close', () => {
    console.log('\nReadline interface closed. Goodbye!');
    if (ws.readyState === ws_1.default.OPEN || ws.readyState === ws_1.default.CONNECTING) {
        ws.close(); // Ensure WS is closed if readline closes unexpectedly
    }
    // process.exit(0); // Exit is handled by ws.on('close')
});
