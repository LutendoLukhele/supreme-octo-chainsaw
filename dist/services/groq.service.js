"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.groqService = exports.GroqService = void 0;
const groq_sdk_1 = __importDefault(require("groq-sdk"));
class GroqService {
    constructor() {
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            throw new Error('GROQ_API_KEY environment variable is required');
        }
        this.client = new groq_sdk_1.default({ apiKey });
    }
    async executeSearch(prompt, options = {}) {
        try {
            const response = await this.client.chat.completions.create({
                model: process.env.GROQ_MODEL ?? 'groq/compound',
                messages: [
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
                temperature: 0.7,
                stream: false,
                ...(options.searchSettings ? { search_settings: options.searchSettings } : {}),
            });
            return {
                content: response.choices[0].message?.content ?? '',
                model: response.model ?? '',
                usage: response.usage ?? {},
                executedTools: response.choices[0].message?.tool_calls,
                reasoning: response.choices[0]?.message?.reasoning,
            };
        }
        catch (error) {
            throw new Error(`Groq API error: ${error?.message ?? 'Unknown error'}`);
        }
    }
    async *executeSearchStream(prompt, options = {}) {
        try {
            const stream = await this.client.chat.completions.create({
                model: process.env.GROQ_MODEL ?? 'groq/compound',
                messages: [
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
                temperature: 0.7,
                stream: true,
                ...(options.searchSettings ? { search_settings: options.searchSettings } : {}),
            });
            for await (const chunk of stream) {
                yield chunk;
            }
        }
        catch (error) {
            throw new Error(`Groq API error: ${error?.message ?? 'Unknown error'}`);
        }
    }
}
exports.GroqService = GroqService;
exports.groqService = new GroqService();
