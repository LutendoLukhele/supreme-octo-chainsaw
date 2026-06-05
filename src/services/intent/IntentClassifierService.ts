import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { ActionStep } from '../PlannerService';
import { ENTITY_NORMALIZERS } from '@aso/workflow-contracts';
import { WordPieceTokenizer } from './WordPieceTokenizer';

export interface IntentClassification {
  label: string;
  confidence: number;
  parameters: Record<string, any>;
  source?: 'rules' | 'onnx';
}

export interface IIntentClassifier {
  classify(userMessage: string): IntentClassification | null;
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

export type ActionPlan = ActionStep[];

export interface ClassifierModelDirs {
  intentModelDir: string;
  nerModelDir?: string;
}

function firstExistingModelDir(candidates: string[], markerFile: string): string | undefined {
  return candidates.find(candidate => fs.existsSync(path.join(candidate, markerFile)));
}

export function resolveClassifierModelDirs(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ClassifierModelDirs {
  const bundledModelsDir = path.join(cwd, '.data', 'model-bundles', 'current', 'models');
  const intentCandidates = [
    path.join(bundledModelsDir, 'intent_classifier'),
    path.join(cwd, 'models', 'intent_classifier'),
    // Legacy fallback only. New bundles should use intent_classifier.
    path.join(cwd, 'models', 'intent-classifier'),
  ];
  const nerCandidates = [
    path.join(bundledModelsDir, 'ner_extractor'),
    path.join(cwd, 'models', 'ner_extractor'),
  ];

  return {
    intentModelDir:
      env.ML_INTENT_MODEL_DIR ||
      firstExistingModelDir(intentCandidates, 'model.onnx') ||
      intentCandidates[0],
    nerModelDir:
      env.ML_NER_MODEL_DIR ||
      firstExistingModelDir(nerCandidates, 'model.onnx') ||
      nerCandidates[0],
  };
}

interface PlanTemplate {
  intentLabel: string;
  displayName: string;
  plan: Array<{
    tool: string;
    intent: string;
    arguments: Record<string, any>;
  }>;
  paramSchema: Record<string, { type: string; source: string }>;
}

/**
 * Intent classifier with two public lanes:
 *
 * - `classify()` is the historical synchronous shadow-classification API used
 *   around the planner. It remains rule-only so older callers stay cheap and
 *   synchronous.
 * - `classifyKnownWorkflow()` is the product workflow recovery lane. It can
 *   use the async ONNX intent + NER models, then fall back to the same rules.
 */
export class IntentClassifierService implements IIntentClassifier {
  private rules: Map<string, RegExp[]> = new Map();
  private planTemplates: Map<string, PlanTemplate> = new Map();
  private onnxClassifier: ONNXClassifierSlot | null = null;

  constructor(planTemplatesPath?: string) {
    this.registerBuiltinRules();
    if (planTemplatesPath) {
      this.loadPlanTemplates(planTemplatesPath);
    }
    logger.info('IntentClassifierService initialized', {
      ruleCount: this.rules.size,
      templateCount: this.planTemplates.size,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  classify(userMessage: string): IntentClassification | null {
    // Keep the legacy shadow-classification API synchronous and cheap.
    const ruleResult = this.classifyByRules(userMessage);
    if (ruleResult) {
      logger.info('Intent classified by rules', { label: ruleResult.label });
      return ruleResult;
    }

    // The async ONNX lane is intentionally exposed only through
    // classifyKnownWorkflow().
    return null;
  }

  getPlanTemplate(intentLabel: string): ActionPlan | null {
    const template = this.planTemplates.get(intentLabel);
    if (!template) return null;

    return template.plan.map((step, idx) => ({
      id: `action_${idx + 1}`,
      intent: step.intent,
      tool: step.tool,
      arguments: JSON.parse(JSON.stringify(step.arguments)),
      status: 'ready' as const,
      stepNumber: idx + 1,
      totalSteps: template.plan.length,
    }));
  }

  /**
   * Fill {{param.X}} placeholders in a plan template with extracted parameters.
   */
  fillTemplateParams(plan: ActionPlan, params: Record<string, any>): ActionPlan {
    const json = JSON.stringify(plan);
    let filled = json;
    for (const [key, value] of Object.entries(params)) {
      const placeholder = `{{param.${key}}}`;
      filled = filled.split(placeholder).join(
        typeof value === 'string' ? value : JSON.stringify(value),
      );
    }
    return JSON.parse(filled);
  }

  /**
   * Hot-load ONNX models at runtime (called after the training pipeline produces artifacts).
   */
  async loadONNXModel(intentModelDir: string, nerModelDir?: string): Promise<void> {
    try {
      // Dynamic require — onnxruntime-node is an optional dependency
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ort = require('onnxruntime-node');
      this.onnxClassifier = new ONNXClassifierSlot(ort, intentModelDir, nerModelDir);
      await this.onnxClassifier.load();
      logger.info('ONNX workflow classifier loaded', { intentModelDir, nerModelDir });
    } catch (err) {
      logger.warn('WorkflowIntentClassifier ONNX unavailable; continuing rules-only', {
        error: (err as Error).message,
        platform: process.platform,
        arch: process.arch,
        intentModelDir,
        nerModelDir,
      });
      this.onnxClassifier = null;
    }
  }

  /**
   * Product workflow recovery path.
   *
   * The historical `classify()` API stays synchronous for rule-only callers.
   * Known workflow recovery can use the async ONNX runtime and falls back to the
   * same rules if models are unavailable or confidence is below threshold.
   */
  async classifyKnownWorkflow(userMessage: string): Promise<IntentClassification | null> {
    const onnxResult = await this.onnxClassifier?.predict(userMessage);
    if (onnxResult && onnxResult.confidence >= 0.85) {
      logger.info('Workflow classified by ONNX', {
        label: onnxResult.label,
        confidence: onnxResult.confidence,
      });
      return {
        ...onnxResult,
        parameters: {
          ...this.extractParameters(userMessage.toLowerCase()),
          ...onnxResult.parameters,
        },
        source: 'onnx',
      };
    }

    return this.classifyByRules(userMessage);
  }

  // ---------------------------------------------------------------------------
  // Rule engine
  // ---------------------------------------------------------------------------

  private classifyByRules(message: string): IntentClassification | null {
    const lower = message.toLowerCase().trim();
    for (const [label, patterns] of this.rules) {
      for (const pattern of patterns) {
        if (pattern.test(lower)) {
          return {
            label,
            confidence: 0.92,
            parameters: this.extractParameters(lower),
            source: 'rules',
          };
        }
      }
    }
    return null;
  }

  private registerBuiltinRules(): void {
    // Single-tool intents
    this.rules.set('fetch_emails', [
      /(?:check|get|fetch|show|find|read)\s+(?:my\s+)?(?:latest\s+|recent\s+|new\s+|unread\s+)?emails?/,
      /(?:check|get|fetch|show|find|read)\s+(?:my\s+)?(?:\d+\s+)?(?:most\s+)?(?:latest\s+|recent\s+|new\s+|unread\s+)?(?:\w+\s+){0,4}emails?/,
      /(?:email|inbox)\s+(?:summary|digest|overview)/,
      /(?:any|what)\s+(?:new\s+)?(?:emails?|messages?)/,
    ]);

    this.rules.set('send_email', [
      /(?:send|write|compose|draft)\s+(?:an?\s+)?email/,
      /email\s+(?:\w+\s+)*(?:to|about)\b/,
    ]);

    this.rules.set('fetch_calendar_events', [
      /(?:check|get|fetch|show|what(?:'s| is))\s+(?:my\s+)?(?:calendar|schedule|agenda|meetings?|events?)/,
      /(?:what|any)\s+(?:meetings?|events?)\s+(?:today|tomorrow|this week)/,
    ]);

    this.rules.set('create_calendar_event', [
      /(?:create|schedule|book|set up|add)\s+(?:a\s+)?(?:meeting|event|appointment|call)/,
    ]);

    this.rules.set('fetch_entity', [
      /(?:get|fetch|show|find|look up|pull)\s+(?:my\s+)?(?:salesforce\s+)?(?:leads?|contacts?|accounts?|deals?|opportunities?|cases?)/,
      /(?:summarize|summary|review|analy[sz]e)\s+(?:my\s+)?(?:warm\s+|open\s+|stalled\s+)?(?:deals?|opportunities?|pipeline)/,
      /(?:crm|salesforce)\s+(?:data|records?|info)/,
    ]);

    this.rules.set('update_entity', [
      /(?:update|change|modify|edit)\s+(?:the\s+)?(?:lead|contact|account|deal|opportunity|case)/,
    ]);

    // Multi-tool composite intents
    this.rules.set('fetch_entity__send_email', [
      /(?:get|fetch|pull)\s+.+(?:and|then)\s+(?:send|email)\b/,
      /(?:email|send)\s+.+(?:from\s+)?(?:salesforce|crm)\b/,
    ]);

    this.rules.set('fetch_emails__send_email', [
      /(?:check|read)\s+(?:my\s+)?emails?\s+(?:and|then)\s+(?:reply|respond|forward)/,
    ]);

    this.rules.set('fetch_entity__generate_file', [
      /(?:generate|create|make|build)\s+(?:a\s+)?(?:\w+\s+)?report/,
      /(?:export|download)\s+.+(?:to|as)\s+(?:excel|csv|spreadsheet|xlsx)/,
    ]);

    this.rules.set('fetch_entity__generate_file__send_email', [
      /(?:generate|create|make)\s+(?:a\s+)?report\s+(?:and|then)\s+(?:send|email)/,
      /(?:pull|get)\s+.+(?:report|spreadsheet).+(?:email|send)/,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Parameter extraction (regex + heuristics, no ML required)
  // ---------------------------------------------------------------------------

  private extractParameters(message: string): Record<string, any> {
    const params: Record<string, any> = {};

    // Date range extraction
    const datePatterns: [RegExp, string][] = [
      [/(?:last|past)\s+(\d+)\s+days?/, 'last_N_days'],
      [/(?:last|past)\s+(\d+)\s+weeks?/, 'last_N_weeks'],
      [/(?:last|past)\s+(\d+)\s+months?/, 'last_N_months'],
      [/(?:this|current)\s+week/, 'this_week'],
      [/(?:this|current)\s+month/, 'this_month'],
      [/today/, 'today'],
      [/tomorrow/, 'tomorrow'],
      [/yesterday/, 'yesterday'],
    ];
    for (const [pattern, label] of datePatterns) {
      const m = message.match(pattern);
      if (m) {
        params.dateRange = label.includes('N') ? label.replace('N', m[1]) : label;
        break;
      }
    }

    // Entity type extraction
    const entityPatterns: [RegExp, string][] = [
      [/\bleads?\b/, 'Lead'],
      [/\bcontacts?\b/, 'Contact'],
      [/\baccounts?\b/, 'Account'],
      [/\b(?:deals?|opportunities?)\b/, 'Opportunity'],
      [/\bcases?\b/, 'Case'],
    ];
    for (const [pattern, entityType] of entityPatterns) {
      if (pattern.test(message)) {
        params.entityType = entityType;
        break;
      }
    }

    // Limit extraction
    // Avoid treating date phrases like "last 7 days" as "limit 7".
    const limitMatch = message.match(/(?:top|first|latest|last|recent)\s+(\d+)(?!\s+(?:days?|weeks?|months?))/);
    if (limitMatch) {
      params.limit = parseInt(limitMatch[1], 10);
    }

    return params;
  }

  // ---------------------------------------------------------------------------
  // Plan template loading
  // ---------------------------------------------------------------------------

  private loadPlanTemplates(dirPath: string): void {
    try {
      const fs = require('fs');
      const path = require('path');
      if (!fs.existsSync(dirPath)) {
        logger.info('Plan templates directory does not exist yet', { dirPath });
        return;
      }
      const files: string[] = fs.readdirSync(dirPath).filter((f: string) => f.endsWith('.json'));
      for (const file of files) {
        const template: PlanTemplate = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf-8'));
        this.planTemplates.set(template.intentLabel, template);
      }
      logger.info('Loaded plan templates', { count: this.planTemplates.size });
    } catch (err) {
      logger.error('Failed to load plan templates', { error: (err as Error).message });
    }
  }
}

// ---------------------------------------------------------------------------
// ONNX classifier slot — dormant until a model is trained and placed
// ---------------------------------------------------------------------------

class ONNXClassifierSlot {
  private intentSession: any = null;
  private nerSession: any = null;
  private intentLabelMap: Record<string, string> = {};
  private nerLabelMap: Record<string, string> = {};
  private tokenizer: WordPieceTokenizer | null = null;

  constructor(
    private ort: any,
    private intentModelDir: string,
    private nerModelDir?: string,
  ) {}

  async load(): Promise<void> {
    const path = require('path');
    const fs = require('fs');

    const intentModelPath = path.join(this.intentModelDir, 'model.onnx');
    const intentLabelsPath = path.join(this.intentModelDir, 'intent_id2label.json');
    const tokenizerPath = path.join(this.intentModelDir, 'tokenizer.json');

    this.intentSession = await this.ort.InferenceSession.create(intentModelPath);
    this.intentLabelMap = JSON.parse(fs.readFileSync(intentLabelsPath, 'utf-8'));
    this.tokenizer = new WordPieceTokenizer(JSON.parse(fs.readFileSync(tokenizerPath, 'utf-8')));

    if (this.nerModelDir) {
      const nerModelPath = path.join(this.nerModelDir, 'model.onnx');
      const nerLabelsPath = path.join(this.nerModelDir, 'ner_id2label.json');
      if (fs.existsSync(nerModelPath) && fs.existsSync(nerLabelsPath)) {
        this.nerSession = await this.ort.InferenceSession.create(nerModelPath);
        this.nerLabelMap = JSON.parse(fs.readFileSync(nerLabelsPath, 'utf-8'));
      }
    }
  }

  async predict(text: string): Promise<IntentClassification | null> {
    if (!this.intentSession || !this.tokenizer) return null;

    const encoded = this.tokenizer.encode(text);
    const feeds = this.buildFeeds(encoded);
    const intentOutputs = await this.intentSession.run(feeds);
    const intentLogits = this.readLogits(intentOutputs);
    const { index, confidence } = this.argmaxSoftmax(intentLogits);
    const label = this.intentLabelMap[String(index)];
    if (!label) return null;

    const parameters = this.nerSession
      ? await this.extractParametersWithNer(encoded)
      : {};

    return {
      label,
      confidence,
      parameters,
      source: 'onnx',
    };
  }

  private buildFeeds(encoded: ReturnType<WordPieceTokenizer['encode']>): Record<string, any> {
    return {
      input_ids: new this.ort.Tensor('int64', BigInt64Array.from(encoded.inputIds), [1, encoded.inputIds.length]),
      attention_mask: new this.ort.Tensor('int64', BigInt64Array.from(encoded.attentionMask), [1, encoded.attentionMask.length]),
    };
  }

  private readLogits(outputs: Record<string, any>): Float32Array {
    const tensor = outputs.logits ?? Object.values(outputs)[0];
    return tensor.data as Float32Array;
  }

  private argmaxSoftmax(logits: Float32Array): { index: number; confidence: number } {
    let max = Number.NEGATIVE_INFINITY;
    for (const value of logits) max = Math.max(max, value);
    const exps = Array.from(logits, (value) => Math.exp(value - max));
    const denominator = exps.reduce((sum, value) => sum + value, 0);
    let index = 0;
    for (let i = 1; i < exps.length; i++) {
      if (exps[i] > exps[index]) index = i;
    }
    return { index, confidence: exps[index] / denominator };
  }

  private async extractParametersWithNer(
    encoded: ReturnType<WordPieceTokenizer['encode']>,
  ): Promise<Record<string, any>> {
    const outputs = await this.nerSession.run(this.buildFeeds(encoded));
    const logits = this.readLogits(outputs);
    const labelCount = Object.keys(this.nerLabelMap).length;
    const wordLabels = new Map<number, string>();

    encoded.wordIds.forEach((wordId, position) => {
      if (wordId === null || wordLabels.has(wordId)) return;
      const offset = position * labelCount;
      let bestIndex = 0;
      for (let i = 1; i < labelCount; i++) {
        if (logits[offset + i] > logits[offset + bestIndex]) bestIndex = i;
      }
      wordLabels.set(wordId, this.nerLabelMap[String(bestIndex)] ?? 'O');
    });

    const labels = encoded.words.map((_, index) => wordLabels.get(index) ?? 'O');
    const spans = this.bioToSpans(encoded.words, labels);
    const params: Record<string, any> = {
      slots: spans,
    };

    for (const span of spans) {
      if (span.type === 'ENTITY_TYPE') {
        params.entityType = ENTITY_NORMALIZERS[span.text] ?? params.entityType;
      }
      if (span.type === 'DATE') {
        params.dateRange = this.normalizeDateRange(span.text) ?? params.dateRange;
      }
      if (span.type === 'FORMAT') {
        params.format = ENTITY_NORMALIZERS[span.text] ?? params.format;
      }
    }
    return params;
  }

  private bioToSpans(
    words: string[],
    labels: string[],
  ): Array<{ type: string; text: string }> {
    const spans: Array<{ type: string; text: string }> = [];
    let currentType: string | null = null;
    let currentWords: string[] = [];

    const flush = () => {
      if (currentType && currentWords.length) {
        spans.push({ type: currentType, text: currentWords.join(' ') });
      }
      currentType = null;
      currentWords = [];
    };

    labels.forEach((label, index) => {
      if (label.startsWith('B-')) {
        flush();
        currentType = label.slice(2);
        currentWords = [words[index]];
        return;
      }
      if (label.startsWith('I-') && currentType === label.slice(2)) {
        currentWords.push(words[index]);
        return;
      }
      flush();
    });
    flush();
    return spans;
  }

  private normalizeDateRange(raw: string): string | undefined {
    const normalized = raw.toLowerCase();
    const dateMap: Record<string, string> = {
      today: 'today',
      'this week': 'this_week',
      'this month': 'this_month',
      'last 30 days': 'last_30_days',
      'last 7 days': 'last_7_days',
    };
    return dateMap[normalized];
  }
}
