// src/services/router.service.ts

import Groq from 'groq-sdk';
import { Mode } from '../models/interpretive.model';

export interface RouterOutput {
    mode: Mode;
    intent: string;
    entities: string[];
    confidence: number;
}

export class RouterService {
    private client: Groq;

    constructor() {
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            throw new Error('GROQ_API_KEY environment variable is required');
        }
        this.client = new Groq({ apiKey });
    }

    public async detectIntent(userQuery: string): Promise<RouterOutput> {
        const defaultResponse: RouterOutput = {
            mode: 'EXPLORATORY',
            intent: 'general query',
            entities: [],
            confidence: 0.5,
        };

        try {
            const response = await this.client.chat.completions.create({
                model: 'mixtral-8x7b-32768',
                messages: [
                    {
                        role: 'system',
                        content: `You are a query classifier. Classify user queries into one of three modes:

TARGETED: Queries about specific people, companies, or entities
EXPLORATORY: Questions about topics, concepts, or "how does X work"
ANALYTICAL: Comparisons or "X vs Y" queries

Respond ONLY with JSON:
{
  "mode": "TARGETED" | "EXPLORATORY" | "ANALYTICAL",
  "intent": "brief description",
  "entities": ["extracted", "entities"],
  "confidence": 0.95
}`,
                    },
                    {
                        role: 'user',
                        content: userQuery,
                    },
                ],
                temperature: 0.1,
                response_format: { type: 'json_object' },
            });

            const content = response.choices[0].message?.content;
            if (!content) return defaultResponse;

            const parsed = JSON.parse(content);
            return {
                mode: parsed.mode ?? defaultResponse.mode,
                intent: parsed.intent ?? defaultResponse.intent,
                entities: parsed.entities ?? defaultResponse.entities,
                confidence: parsed.confidence ?? defaultResponse.confidence,
            };
        } catch (error) {
            return defaultResponse;
        }
    }
}

export const routerService = new RouterService();
