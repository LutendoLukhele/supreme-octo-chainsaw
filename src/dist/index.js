"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const ws_1 = __importDefault(require("ws"));
const winston_1 = __importDefault(require("winston"));
const config_1 = require("./config");
const ConversationService_1 = require("./services/conversation/ConversationService");
const ToolOrchestrator_1 = require("./services/tool/ToolOrchestrator");
const StreamManager_1 = require("./services/stream/StreamManager");
const NangoService_1 = require("./services/NangoService");
const FollowUpService_1 = require("./services/FollowUpService");
const groq_sdk_1 = __importDefault(require("groq-sdk"));
// Configure logger
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json()),
    transports: [
        new winston_1.default.transports.Console(),
        new winston_1.default.transports.File({ filename: 'error.log', level: 'error' }),
        new winston_1.default.transports.File({ filename: 'combined.log' })
    ]
});
// Initialize services
const nangoService = new NangoService_1.NangoService();
const conversationConfig = {
    groqApiKey: config_1.CONFIG.GROQ_API_KEY,
    model: config_1.CONFIG.MODEL_NAME,
    maxTokens: config_1.CONFIG.MAX_TOKENS // Converts the env value to a number
    ,
    nangoService: new NangoService_1.NangoService,
    client: undefined,
    tools: [],
    logger
};
const conversationService = new ConversationService_1.ConversationService(conversationConfig);
const followUpService = new FollowUpService_1.FollowUpService(new groq_sdk_1.default({ apiKey: config_1.CONFIG.GROQ_API_KEY }), config_1.CONFIG.MODEL_NAME, config_1.CONFIG.MAX_TOKENS);
// Setup event handling for follow-up response streaming
followUpService.on('send_chunk', (sessionId, chunk) => {
    streamManager.sendChunk(sessionId, chunk);
});
// Removed logger from ToolOrchestrator config because ToolConfig doesn't support it.
const toolOrchestrator = new ToolOrchestrator_1.ToolOrchestrator({
    configPath: config_1.CONFIG.TOOL_CONFIG_PATH,
    nangoService,
    input: {}, // Define the input format 
    name: "tool-orchestrator",
    description: "Orchestrates the execution of tools",
    parameters: {
        type: "object",
        properties: {} // Define the properties expected by tools
    },
    default_params: {}
});
const streamManager = new StreamManager_1.StreamManager({
    logger,
    chunkSize: config_1.CONFIG.STREAM_CHUNK_SIZE
});
// Setup Express app
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Create HTTP server
const server = (0, http_1.createServer)(app);
// Setup WebSocket server
const wss = new ws_1.default.Server({ server });
wss.on('connection', (ws, req) => {
    const sessionId = req.url?.slice(1) || Math.random().toString(36).substring(7);
    streamManager.addConnection(sessionId, ws);
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            // Add this - Log the raw incoming message as full JSON
            logger.info('AI_MESSAGE_RECEIVED', { raw_message: JSON.stringify(data), sessionId });
            // Process the message through conversation service
            const response = await conversationService.processMessage(data.content, sessionId);
            // Add this - Log the complete AI response
            logger.info('AI_RESPONSE_GENERATED', { raw_response: JSON.stringify(response), sessionId });
            // Stream the response content
            for await (const chunk of streamManager.createStream(response.content)) {
                // Log each chunk sent to client
                logger.debug('CHUNK_SENT', { chunk: JSON.stringify(chunk), sessionId });
                streamManager.sendChunk(sessionId, chunk);
            }
            // Handle tool calls if present
            if (response.toolCalls) {
                for (const toolCall of response.toolCalls) {
                    // Log tool call
                    logger.info('TOOL_CALL_STARTED', { toolCall: JSON.stringify(toolCall), sessionId });
                    // Send tool call start notification
                    streamManager.sendChunk(sessionId, {
                        type: 'tool_call',
                        content: `Executing tool: ${toolCall.function.name}`,
                        toolCallId: toolCall.id
                    });
                    // Execute tool; supply a non-empty object for args and a timestamp.
                    const result = await toolOrchestrator.executeTool({
                        name: toolCall.function.name,
                        arguments: JSON.parse(toolCall.function.arguments),
                        sessionId,
                        id: '',
                        ToolName: '',
                        args: {},
                        result: {},
                    });
                    // Log tool result
                    logger.info('TOOL_RESULT', { result: JSON.stringify(result), toolCallId: toolCall.id, sessionId });
                    // Send tool result
                    followUpService.triggerFollowUp({
                        toolName: toolCall.function.name,
                        toolResult: result,
                        sessionId: sessionId
                    });
                    streamManager.sendChunk(sessionId, {
                        type: 'tool_result',
                        content: JSON.stringify(result),
                        toolCallId: toolCall.id
                    });
                }
            }
        }
        catch (error) {
            logger.error('Error processing message', { error, sessionId });
            streamManager.sendChunk(sessionId, {
                type: 'error',
                content: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });
}); // Add this closing brace here
// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});
// Start server
const PORT = config_1.CONFIG.PORT || 3000;
server.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
});
// Handle graceful shutdown
// Handle graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});
