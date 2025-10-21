// src/services/groq.service.ts

import Groq from 'groq-sdk';

interface GroqResponse {
    content: string;
    model: string;
    usage: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    executedTools?: unknown;
    reasoning?: string;
}

export interface SearchSettings {
    exclude_domains?: string[];
    include_domains?: string[];
    country?: string;
}

interface ExecuteOptions {
    searchSettings?: SearchSettings;
}

export class GroqService {
    private client: Groq;

    constructor() {
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            throw new Error('GROQ_API_KEY environment variable is required');
        }
        this.client = new Groq({ apiKey });
    }

    public async executeSearch(prompt: string, options: ExecuteOptions = {}): Promise<GroqResponse> {
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
                // Forward web search controls to Compound/Compound-mini
                // See Groq docs: search_settings: { include_domains, exclude_domains, country }
                ...(options.searchSettings ? { search_settings: options.searchSettings } : {}),
            });

            return {
                content: response.choices[0].message?.content ?? '',
                model: response.model ?? '',
                usage: response.usage ?? {},
                executedTools: response.choices[0].message?.tool_calls,
                reasoning: (response.choices[0] as any)?.message?.reasoning,
            };
        } catch (error: any) {
            throw new Error(`Groq API error: ${error?.message ?? 'Unknown error'}`);
        }
    }

    public async *executeSearchStream(prompt: string, options: ExecuteOptions = {}): AsyncGenerator<Groq.Chat.Completions.ChatCompletionChunk> {
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

        } catch (error: any) {
            throw new Error(`Groq API error: ${error?.message ?? 'Unknown error'}`);
        }
    }
}

export const groqService = new GroqService();
