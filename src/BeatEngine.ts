import fs from 'fs';
import { v4 as uuid } from 'uuid';
import OpenAI from 'openai';
import { ToolConfigManager } from './services/tool/ToolConfigManager';
import { BeatUIJSON } from './types/beats';

interface InvokeBeatContext {
  sessionId: string;
  messageId: string;
  intendedToolName: string;
  missingParams: string[];
  [key: string]: any; // Allow other context properties
}

export class BeatEngine {
  private client = new OpenAI({
    // Ensure OPENAI_API_KEY is set in your Cloud Run environment.
    apiKey: process.env.OPENAI_API_KEY,
  });
  private multiBeatSystemPrompt = fs.readFileSync(
    __dirname + '/prompts/beatSystemPrompt.txt',
    'utf-8'
  );

  constructor(private toolConfig: ToolConfigManager) {}

  async generateBeats(phase: string, context: any): Promise<BeatUIJSON[]> {
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
    return raw.map((b: any) => ({
      id: b.id || uuid(),
      timestamp: new Date().toISOString(),
      ...b
    }));
  }

  async invokeBeat(beatType: string, context: InvokeBeatContext): Promise<BeatUIJSON | null> {
    const singleBeatSystemPromptContent = fs.readFileSync(
      __dirname + '/prompts/singleBeatSystemPrompt.txt',
      'utf-8'
    );
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
      if (!rawContent) return null;

      const rawBeat = JSON.parse(rawContent.trim() || '{}');

      if (Object.keys(rawBeat).length === 0 || !rawBeat.type || !rawBeat.content) { // Basic validation for a meaningful beat
        return null;
      }

      return { id: rawBeat.id || uuid(), timestamp: new Date().toISOString(), ...rawBeat, };
    } catch (error) {
      console.error(`Error invoking beat type ${beatType}:`, error);
      return null; // Return null on error so the calling service can use a fallback
    }
  }
}
