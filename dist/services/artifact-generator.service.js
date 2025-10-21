"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.artifactGeneratorService = exports.ArtifactGeneratorService = void 0;
const groq_sdk_1 = __importDefault(require("groq-sdk"));
class ArtifactGeneratorService {
    constructor() {
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            throw new Error('GROQ_API_KEY environment variable is required');
        }
        this.client = new groq_sdk_1.default({ apiKey });
    }
    async generateCodeArtifact(request) {
        const { prompt, language, context } = request;
        try {
            const response = await this.client.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: `You are an expert ${language} programmer. Generate clean, well-documented, production-ready code based on the user's request. Include comments explaining key logic.`,
                    },
                    {
                        role: 'user',
                        content: this.buildCodePrompt(prompt, language, context),
                    },
                ],
                temperature: 0.3,
                max_tokens: 2000,
            });
            const messageContent = response.choices[0].message?.content ?? '';
            const code = this.extractCode(messageContent);
            return {
                id: this.generateId(),
                userId: '',
                type: 'code',
                title: this.generateTitle(prompt),
                content: code,
                language,
                status: 'ready',
                createdAt: new Date(),
                metadata: {
                    linesOfCode: code.split('\n').length,
                    dependencies: this.extractDependencies(code, language),
                },
            };
        }
        catch (error) {
            throw new Error(`Artifact generation failed: ${error?.message ?? 'Unknown error'}`);
        }
    }
    async generateAnalysisArtifact(request) {
        const { data, analysisType, context } = request;
        try {
            const response = await this.client.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a data analyst. Generate Python code to analyze the provided data and produce insights.',
                    },
                    {
                        role: 'user',
                        content: this.buildAnalysisPrompt(data, analysisType, context),
                    },
                ],
                temperature: 0.3,
                max_tokens: 2000,
            });
            const messageContent = response.choices[0].message?.content ?? '';
            const code = this.extractCode(messageContent);
            return {
                id: this.generateId(),
                userId: '',
                type: 'analysis',
                title: `${analysisType} Analysis`,
                content: code,
                language: 'python',
                status: 'ready',
                createdAt: new Date(),
                metadata: {
                    linesOfCode: code.split('\n').length,
                    dependencies: this.extractDependencies(code, 'python'),
                },
            };
        }
        catch (error) {
            throw new Error(`Analysis artifact generation failed: ${error?.message ?? 'Unknown error'}`);
        }
    }
    async generateVisualizationArtifact(request) {
        const { data, chartType, title } = request;
        const pythonCode = this.generateVisualizationTemplate(data, chartType, title);
        return {
            id: this.generateId(),
            userId: '',
            type: 'visualization',
            title: title || `${chartType} Chart`,
            content: pythonCode,
            language: 'python',
            status: 'ready',
            createdAt: new Date(),
            metadata: {
                linesOfCode: pythonCode.split('\n').length,
                dependencies: ['matplotlib', 'pandas', 'numpy'],
            },
        };
    }
    buildCodePrompt(prompt, language, context) {
        let fullPrompt = `Generate ${language} code for: ${prompt}\n\n`;
        if (context) {
            fullPrompt += `Context:\n${JSON.stringify(context, null, 2)}\n\n`;
        }
        fullPrompt += `Requirements:
- Write clean, readable code with comments
- Include error handling
- Follow ${language} best practices
- Make it production-ready
- Return ONLY the code, no explanations`;
        return fullPrompt;
    }
    buildAnalysisPrompt(data, analysisType, context) {
        return `Analyze this data using ${analysisType} analysis:

Data:
${JSON.stringify(data, null, 2)}

${context ? `Context: ${JSON.stringify(context, null, 2)}` : ''}

Generate Python code that:
1. Loads and validates the data
2. Performs ${analysisType} analysis
3. Generates statistical summaries
4. Creates visualizations if appropriate
5. Outputs results in a structured format

Return ONLY the Python code, no explanations.`;
    }
    generateVisualizationTemplate(data, chartType, title) {
        const dataStr = JSON.stringify(data, null, 2);
        return `import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
import json

# Load data
data = json.loads('''${dataStr}''')
df = pd.DataFrame(data)

# Create ${chartType} visualization
plt.figure(figsize=(12, 6))
plt.style.use('seaborn-v0_8-darkgrid')

# Generate chart based on type
${this.getChartCode(chartType)}

plt.title('${title}', fontsize=16, fontweight='bold')
plt.xlabel('X Axis', fontsize=12)
plt.ylabel('Y Axis', fontsize=12)
plt.legend()
plt.tight_layout()

# Save output
plt.savefig('${title.toLowerCase().replace(/\s+/g, '_')}.png', dpi=300, bbox_inches='tight')
print("Visualization created successfully")
`;
    }
    getChartCode(chartType) {
        switch (chartType) {
            case 'bar':
                return `plt.bar(df['label'], df['value'], color='#667EEA', alpha=0.8)`;
            case 'line':
                return `plt.plot(df['x'], df['y'], marker='o', linewidth=2, markersize=6)`;
            case 'scatter':
                return `plt.scatter(df['x'], df['y'], s=100, alpha=0.6, c='#667EEA')`;
            case 'pie':
                return `plt.pie(df['value'], labels=df['label'], autopct='%1.1f%%', startangle=90)`;
            case 'histogram':
                return `plt.hist(df['value'], bins=20, color='#667EEA', alpha=0.7, edgecolor='black')`;
            default:
                return `plt.plot(df.index, df.values)`;
        }
    }
    extractCode(content) {
        const codeBlockMatch = content.match(/```[\w]*\n([\s\S]*?)```/);
        if (codeBlockMatch) {
            return codeBlockMatch[1].trim();
        }
        return content.trim();
    }
    generateTitle(prompt) {
        const words = prompt.split(' ');
        return words.slice(0, 5).join(' ') + (words.length > 5 ? '...' : '');
    }
    extractDependencies(code, language) {
        const dependencies = [];
        if (language === 'python') {
            const importMatches = code.matchAll(/(?:import|from)\s+(\w+)/g);
            for (const match of importMatches) {
                dependencies.push(match[1]);
            }
        }
        else if (language === 'javascript' || language === 'typescript') {
            const requireMatches = code.matchAll(/require\(['"]([\w@/.-]+)['"]\)/g);
            const importMatches = code.matchAll(/import\s+.*?\s+from\s+['"]([\w@/.-]+)['"]/g);
            for (const match of requireMatches) {
                dependencies.push(match[1]);
            }
            for (const match of importMatches) {
                dependencies.push(match[1]);
            }
        }
        return Array.from(new Set(dependencies));
    }
    generateId() {
        return `art_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }
}
exports.ArtifactGeneratorService = ArtifactGeneratorService;
exports.artifactGeneratorService = new ArtifactGeneratorService();
