"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BeatEngine = void 0;
const fs_1 = __importDefault(require("fs"));
const uuid_1 = require("uuid");
const openai_1 = __importDefault(require("openai"));
class BeatEngine {
    toolConfig;
    client = new openai_1.default({
        // Ensure OPENAI_API_KEY is set in your Cloud Run environment.
        apiKey: process.env.OPENAI_API_KEY,
    });
    multiBeatSystemPrompt = fs_1.default.readFileSync(__dirname + '/prompts/beatSystemPrompt.txt', 'utf-8');
    constructor(toolConfig) {
        this.toolConfig = toolConfig;
    }
    async generateBeats(phase, context) {
        // Ensure this method still works as intended for generating multiple beats
        const mainSchemas = this.toolConfig.formatToolsForLLMPrompt();
        const prompt = this.multiBeatSystemPrompt
            .replace('{{phase}}', phase)
            .replace('{{context}}', JSON.stringify(context))
            .replace('{{mainToolSchemas}}', JSON.stringify(mainSchemas));
        const res = await this.client.chat.completions.create({
            model: 'gpt-4.1-mini-2025-04-14',
            messages: [{ role: 'system', content: prompt }]
        });
        const raw = JSON.parse(res.choices[0].message.content || '[]');
        return raw.map((b) => ({
            id: b.id || (0, uuid_1.v4)(),
            timestamp: new Date().toISOString(),
            ...b
        }));
    }
    async invokeBeat(beatType, context) {
        const singleBeatSystemPromptContent = fs_1.default.readFileSync(__dirname + '/prompts/singleBeatSystemPrompt.txt', 'utf-8');
        const mainSchemas = this.toolConfig.formatToolsForLLMPrompt();
        const prompt = singleBeatSystemPromptContent
            .replace('{{beatType}}', beatType)
            .replace('{{context}}', JSON.stringify(context))
            .replace('{{mainToolSchemas}}', JSON.stringify(mainSchemas));
        try {
            const res = await this.client.chat.completions.create({
                model: 'gpt-4.1-mini-2025-04-14', // Or your preferred model for single, focused tasks
                messages: [{ role: 'system', content: prompt }],
                // temperature: 0.5, // Adjust temperature for more deterministic output if needed
            });
            const rawContent = res.choices[0].message.content;
            if (!rawContent)
                return null;
            const rawBeat = JSON.parse(rawContent.trim() || '{}');
            if (Object.keys(rawBeat).length === 0 || !rawBeat.type || !rawBeat.content) { // Basic validation for a meaningful beat
                return null;
            }
            return { id: rawBeat.id || (0, uuid_1.v4)(), timestamp: new Date().toISOString(), ...rawBeat, };
        }
        catch (error) {
            console.error(`Error invoking beat type ${beatType}:`, error);
            return null; // Return null on error so the calling service can use a fallback
        }
    }
}
exports.BeatEngine = BeatEngine;
