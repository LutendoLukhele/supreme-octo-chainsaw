"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationService = void 0;
const groq_sdk_1 = require("groq-sdk");
const BaseService_1 = require("../base/BaseService");
const uuid_1 = require("uuid");
class ConversationService extends BaseService_1.BaseService {
    client;
    model;
    maxTokens;
    messageHistory;
    tools;
    constructor(config) {
        super(config);
        this.client = new groq_sdk_1.Groq({ apiKey: config.groqApiKey });
        this.model = config.model;
        this.maxTokens = config.maxTokens;
        this.messageHistory = new Map();
        this.tools = this.getHardcodedTools();
    }
    processMessage = async (message, sessionId) => {
        try {
            const history = this.getOrCreateHistory(sessionId);
            history.push({ role: 'user', content: message });
            const stream = await this.client.chat.completions.create({
                model: this.model,
                messages: history,
                max_tokens: this.maxTokens,
                tools: this.tools,
                tool_choice: 'auto',
                stream: true
            });
            let fullResponse = "";
            let toolCalls = [];
            try {
                for await (const chunk of stream) {
                    if (chunk.choices[0]?.delta?.content) {
                        fullResponse += chunk.choices[0].delta.content;
                    }
                    if (chunk.choices[0]?.delta?.tool_calls) {
                        const incomingToolCalls = chunk.choices[0].delta.tool_calls || [];
                        for (const toolCall of incomingToolCalls) {
                            const completeToolCall = {
                                id: toolCall.id || (0, uuid_1.v4)(),
                                type: 'function', // Explicitly set as literal 'function'
                                function: {
                                    name: toolCall.function.name,
                                    arguments: toolCall.function.arguments
                                }
                            };
                            toolCalls.push(completeToolCall);
                        }
                    }
                }
                const assistantMessage = { role: 'assistant', content: fullResponse };
                history.push(assistantMessage);
                return {
                    content: fullResponse,
                    toolCalls,
                    tools: this.tools,
                    type: 'final'
                };
            }
            catch (streamError) {
                this.logger.error('Error processing stream', { streamError, sessionId });
                throw streamError;
            }
        }
        catch (error) {
            this.logger.error('Error processing message', { error, sessionId });
            throw error;
        }
    };
    getOrCreateHistory(sessionId) {
        if (!this.messageHistory.has(sessionId)) {
            this.messageHistory.set(sessionId, this.initializeHistory());
        }
        return this.messageHistory.get(sessionId);
    }
    initializeHistory() {
        return [{
                role: 'system',
                content: `You are an AI assistant that can use various tools to help answer questions and perform tasks.

    You can:
    1. Work with Salesforce records (Account, Contact, Lead, Deal, Article, Case) using:
       - fetch_entity: Retrieve records
       - create_entity: Create new records 
       - update_entity: Modify existing records
    
    2. Handle Gmail operations using:
       - fetch_emails: Get emails
       - send_email: Send emails
    
    3. Manage Google Calendar using:
       - create_calendar: Create new calendars
       - update_calendar: Modify calendars
       - create_event: Schedule events/meetings
       - update_event: Update events/meetings
    
    Use the appropriate tool with correct object names and parameters for each operation.
    
    Follow schemas and patterns defined for all tool calls.`
            }];
    }
    getHardcodedTools() {
        return [
            {
                type: "function",
                function: {
                    name: "fetch_entity",
                    description: "Fetch Salesforce records",
                    parameters: {
                        type: "object",
                        properties: {
                            operation: { type: "string", enum: ["fetch"] },
                            entityType: { type: "string", enum: ["Account", "Contact", "Lead", "Deal", "Article", "Case"] },
                            identifier: { type: "string" }
                        },
                        required: ["operation", "entityType", "identifier"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "create_entity",
                    description: "Create Salesforce entity",
                    parameters: {
                        type: "object",
                        properties: {
                            operation: { type: "string", enum: ["create"] },
                            entityType: { type: "string", enum: ["Account", "Contact", "Lead", "Deal", "Article", "Case"] },
                            fields: {
                                type: "object",
                                properties: {
                                    name: { type: "string" },
                                    industry: { type: "string" },
                                    phone: { type: "string" },
                                    website: { type: "string" }
                                },
                                required: ["name"]
                            }
                        },
                        required: ["operation", "entityType", "fields"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "update_entity",
                    description: "Update Salesforce entity",
                    parameters: {
                        type: "object",
                        properties: {
                            operation: { type: "string", enum: ["update"] },
                            entityType: { type: "string", enum: ["Account", "Contact", "Lead", "Deal", "Article", "Case"] },
                            identifier: { type: "string" },
                            fields: {
                                type: "object",
                                minProperties: 1,
                                properties: {
                                    name: { type: "string" },
                                    industry: { type: "string" },
                                    phone: { type: "string" },
                                    website: { type: "string" }
                                }
                            }
                        },
                        required: ["operation", "entityType", "identifier", "fields"]
                    }
                }
            }
        ];
    }
}
exports.ConversationService = ConversationService;
