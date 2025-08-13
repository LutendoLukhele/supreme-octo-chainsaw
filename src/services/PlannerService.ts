import { EventEmitter } from 'events';
import OpenAI from 'openai'; // Use OpenAI SDK
import winston from 'winston';
import { ToolConfigManager } from './tool/ToolConfigManager';
import { Message } from './conversation/types';
import { DEDICATED_PLANNER_SYSTEM_PROMPT_TEMPLATE } from './conversation/prompts/dedicatedPlannerPrompt'; // New prompt
import { StreamChunk } from './stream/types'; 

// Define ActionPlan types (can be moved to a shared types file)
export interface ActionPlanItem {
  function: any;
  id: string;
  intent: string;
  tool: string;
  arguments?: Record<string, any>;
  status: 'ready' | 'conditional';
  requiredParams?: string[]; // List of *required* params missing from the LLM's perspective
}
export type ActionPlan = ActionPlanItem[];

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
});

export class PlannerService extends EventEmitter {
    private client: OpenAI; // OpenAI client will be initialized in constructor
    private model: string;
    private maxTokens: number;
    private toolConfigManager: ToolConfigManager;

    constructor(
        openAIApiKey: string, // Changed from groqApiKey to openAIApiKey
        model: string,
        maxTokens: number,
        toolConfigManager: ToolConfigManager
    ) {
        super();
        this.client = new OpenAI({ apiKey: openAIApiKey }); // Initialize OpenAI client
        this.model = model;
        this.maxTokens = maxTokens;
        this.toolConfigManager = toolConfigManager;
        logger.info('PlannerService initialized with self-managed OpenAI client.');
    }

    /**
     * Generates a structured action plan based on user input and potentially pre-identified tool calls.
     * @param userInput The original user message.
     * @param identifiedToolCalls Optional: Tool calls already identified by other LLM streams.
     * @param sessionId For logging context.
     * @param clientMessageId The ID of the user's message that triggered this planning.
     * @returns A promise that resolves to an ActionPlan.
     */
    public async generatePlan(
        userInput: string,
        identifiedToolCalls: { name: string; arguments: Record<string, any>; id?: string }[],
        sessionId: string,
        clientMessageId: string // Added to associate planner status with original message
    ): Promise<ActionPlan> {
        logger.info('PlannerService: Generating action plan', { 
            sessionId, 
            userInputLength: userInput.length,
            numIdentifiedTools: identifiedToolCalls.length,
            // Log the names of identified tools to see what's coming in
            identifiedToolNames: identifiedToolCalls.map(tc => tc.name) 
        });

        // Emit a status update to the client
        this.emit('send_chunk', sessionId, {
            type: 'planner_status',
            content: 'Formulating a detailed plan...',
            messageId: clientMessageId,
            streamType: 'planner_feedback', // Identifies this as a status from the planner
            isFinal: true // This is a single status update, not a stream of statuses
        } as unknown as StreamChunk);

        const availableTools = this.toolConfigManager.getToolDefinitionsForPlanner(); // Method to get tool schemas suitable for planner prompt
        const toolDefinitionsJson = JSON.stringify(availableTools, null, 2); // Pass tool definitions to the planner prompt

        // Construct a representation of already identified tools for the prompt
        let identifiedToolsPromptSection = "No tools pre-identified.";
        if (identifiedToolCalls.length > 0) {
            identifiedToolsPromptSection = "The following tool calls were preliminarily identified (you should verify and integrate them into a coherent plan):\n";
            identifiedToolCalls.forEach(tc => {
                identifiedToolsPromptSection += `- Tool: ${tc.name}, Arguments: ${JSON.stringify(tc.arguments)}\n`;
            });
        }

        const systemPromptContent = DEDICATED_PLANNER_SYSTEM_PROMPT_TEMPLATE
            .replace('{{USER_CURRENT_MESSAGE}}', userInput)
            .replace('{{TOOL_DEFINITIONS_JSON}}', toolDefinitionsJson)
            .replace('{{PRE_IDENTIFIED_TOOLS_SECTION}}', identifiedToolsPromptSection); // Include pre-identified tools

        const messagesForApi: Message[] = [
            { role: 'system', content: systemPromptContent },
            // { role: 'user', content: userInput } // User input is already in the system prompt
        ];

        let accumulatedContent = "";

        try {
            const responseStream = await this.client.chat.completions.create({
                model: 'gpt-4.1-nano-2025-04-14', // Use the specified model
                messages: messagesForApi as any,
                max_tokens: this.maxTokens, // Adjust as needed for plan complexity
                temperature: 0.1, // Planner should be precise and deterministic
                response_format: { type: "json_object" }, // Request JSON output
                stream: true, // Enable streaming
            });

            for await (const chunk of responseStream) {
                const contentDelta = chunk.choices[0]?.delta?.content;
                if (contentDelta) {
                    accumulatedContent += contentDelta;
                }
                const finishReason = chunk.choices[0]?.finish_reason;
                if (finishReason) {
                    logger.info(`Planner LLM stream finished. Reason: ${finishReason}`, { sessionId, finishReason });
                    break;
                }
            }

            if (!accumulatedContent) {
                logger.error('PlannerService: No content from planning LLM', { sessionId });
                throw new Error('No content from planning LLM');
            }

            // The prompt asks for a JSON object with a "plan" key containing the array.
            const responseObject = JSON.parse(accumulatedContent);
            if (!responseObject.plan || !Array.isArray(responseObject.plan)) {
                logger.error('PlannerService: LLM response is not in the expected format { "plan": [...] }', { sessionId, response: accumulatedContent });
                throw new Error('Planner LLM response is not in the expected format.');
            }
            const actionPlan: ActionPlan = responseObject.plan;

            logger.info(`PlannerService: Plan generated with ${actionPlan.length} actions.`, { 
                sessionId, 
                // Log the generated plan for inspection
                generatedPlan: JSON.stringify(actionPlan, null, 2) 
            });
            return actionPlan;
        } catch (error: any) {
            logger.error('PlannerService: Error generating action plan', { error: error.message, sessionId });
            // Return an empty plan or re-throw, depending on desired error handling
            return [];
        }
    }

    // Methods for emitting events (needed for EventEmitter)
    public emit(event: 'send_chunk', sessionId: string, chunk: StreamChunk): boolean;
    public emit(event: string | symbol, ...args: any[]): boolean {
        return super.emit(event, ...args);
    }

    public on(event: 'send_chunk', listener: (sessionId: string, chunk: StreamChunk) => void): this;
    public on(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }
}