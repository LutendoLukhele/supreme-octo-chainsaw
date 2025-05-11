"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = __importDefault(require("ws"));
const readline = __importStar(require("readline"));
var MessageType;
(function (MessageType) {
    MessageType["USER"] = "USER";
    MessageType["ASSISTANT"] = "ASSISTANT";
    MessageType["SYSTEM"] = "SYSTEM";
    MessageType["STREAM"] = "STREAM";
})(MessageType || (MessageType = {}));
// Generate a simple session id (could be replaced with a UUID generator if desired)
const sessionId = Math.random().toString(36).substring(7);
// Connect to your WebSocket server using the specified endpoint.
const ws = new ws_1.default('ws://localhost:3000/ws');
// Set up a readline interface for CLI input.
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'Enter message> '
});
// When the WebSocket connection opens, start the CLI prompt.
ws.on('open', () => {
    console.log('Connected to WebSocket server.');
    rl.prompt();
});
// Listen for incoming messages from the server.
ws.on('message', (data) => {
    // Assuming the data is in JSON format:
    try {
        const message = JSON.parse(data.toString());
        console.log('Received:', message);
    }
    catch (error) {
        console.error('Error parsing incoming message:', error);
    }
});
// Handle errors and closure of the WebSocket connection.
ws.on('error', (err) => {
    console.error('WebSocket error:', err);
});
ws.on('close', () => {
    console.log('WebSocket connection closed.');
    process.exit(0);
});
// Listen for user input and send messages to the server.
rl.on('line', (input) => {
    // Create a ClientMessage object
    const clientMessage = {
        messageId: `cli-${Date.now()}`,
        content: input,
        sessionId,
        type: MessageType.USER,
    };
    // Send the message to the server.
    if (ws.readyState === ws_1.default.OPEN) {
        ws.send(JSON.stringify(clientMessage));
    }
    else {
        console.error('WebSocket is not open. Message not sent.');
    }
    rl.prompt();
});
// Handle exit (for example on Ctrl+C)
rl.on('SIGINT', () => {
    console.log('Closing connection...');
    ws.close();
    rl.close();
});
