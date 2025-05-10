"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var ws_1 = require("ws");
var readline = require("readline");
var MessageType;
(function (MessageType) {
    MessageType["USER"] = "USER";
    MessageType["ASSISTANT"] = "ASSISTANT";
    MessageType["SYSTEM"] = "SYSTEM";
    MessageType["STREAM"] = "STREAM";
})(MessageType || (MessageType = {}));
// Generate a simple session id (could be replaced with a UUID generator if desired)
var sessionId = Math.random().toString(36).substring(7);
// Connect to your WebSocket server using the specified endpoint.
var ws = new ws_1.default('ws://localhost:3000/ws');
// Set up a readline interface for CLI input.
var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'Enter message> '
});
// When the WebSocket connection opens, start the CLI prompt.
ws.on('open', function () {
    console.log('Connected to WebSocket server.');
    rl.prompt();
});
// Listen for incoming messages from the server.
ws.on('message', function (data) {
    // Assuming the data is in JSON format:
    try {
        var message = JSON.parse(data.toString());
        console.log('Received:', message);
    }
    catch (error) {
        console.error('Error parsing incoming message:', error);
    }
});
// Handle errors and closure of the WebSocket connection.
ws.on('error', function (err) {
    console.error('WebSocket error:', err);
});
ws.on('close', function () {
    console.log('WebSocket connection closed.');
    process.exit(0);
});
// Listen for user input and send messages to the server.
rl.on('line', function (input) {
    // Create a ClientMessage object
    var clientMessage = {
        messageId: "cli-".concat(Date.now()),
        content: input,
        sessionId: sessionId,
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
rl.on('SIGINT', function () {
    console.log('Closing connection...');
    ws.close();
    rl.close();
});
