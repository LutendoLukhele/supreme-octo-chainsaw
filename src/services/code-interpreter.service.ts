// src/services/code-interpreter.service.ts

import Groq from 'groq-sdk';
import { ExecutionResult } from '../models/artifact.model';

interface ExecuteRequest {
    code: string;
    language: string;
    context?: unknown;
}

export class CodeInterpreterService {
    private client: Groq;

    constructor() {
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            throw new Error('GROQ_API_KEY environment variable is required');
        }
        this.client = new Groq({ apiKey });
    }

    public async execute({ code, language, context }: ExecuteRequest): Promise<ExecutionResult> {
        try {
            const response = await this.client.chat.completions.create({
                model: 'groq/compound-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a code execution assistant. Execute the provided code and return the results.',
                    },
                    {
                        role: 'user',
                        content: `Execute this ${language} code:\n\n\`\`\`${language}\n${code}\n\`\`\``,
                    },
                ],
                temperature: 0,
            });

            const resultMessage = response.choices[0].message;

            return {
                success: true,
                output: resultMessage.content || '',
                toolCalls: (resultMessage as any).executed_tools,
                executionTime: response.usage?.total_time ?? null,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message ?? 'Unknown error during code execution',
            };
        }
    }

    public async generateVisualization(
        data: unknown,
        visualizationType: string,
        title: string,
    ): Promise<ExecutionResult> {
        const pythonCode = this.generateVisualizationCode(data, visualizationType, title);

        return this.execute({
            code: pythonCode,
            language: 'python',
            context: { data, visualizationType },
        });
    }

    private generateVisualizationCode(data: unknown, type: string, title: string): string {
        const dataStr = JSON.stringify(data);

        switch (type) {
            case 'bar':
                return `
import matplotlib.pyplot as plt
import json

data = json.loads('${dataStr}')
labels = [item['label'] for item in data]
values = [item['value'] for item in data]

plt.figure(figsize=(10, 6))
plt.bar(labels, values)
plt.title('${title}')
plt.xlabel('Categories')
plt.ylabel('Values')
plt.xticks(rotation=45, ha='right')
plt.tight_layout()
plt.savefig('visualization.png')
print("Visualization saved")
`;

            case 'line':
                return `
import matplotlib.pyplot as plt
import json

data = json.loads('${dataStr}')
x = [item['x'] for item in data]
y = [item['y'] for item in data]

plt.figure(figsize=(10, 6))
plt.plot(x, y, marker='o')
plt.title('${title}')
plt.xlabel('X')
plt.ylabel('Y')
plt.grid(True, alpha=0.3)
plt.tight_layout()
plt.savefig('visualization.png')
print("Visualization saved")
`;

            case 'scatter':
                return `
import matplotlib.pyplot as plt
import json

data = json.loads('${dataStr}')
x = [item['x'] for item in data]
y = [item['y'] for item in data]

plt.figure(figsize=(10, 6))
plt.scatter(x, y, alpha=0.6)
plt.title('${title}')
plt.xlabel('X')
plt.ylabel('Y')
plt.grid(True, alpha=0.3)
plt.tight_layout()
plt.savefig('visualization.png')
print("Visualization saved")
`;

            default:
                throw new Error(`Unsupported visualization type: ${type}`);
        }
    }
}

export const codeInterpreterService = new CodeInterpreterService();
