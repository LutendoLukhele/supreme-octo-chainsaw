import { v4 as uuidv4 } from 'uuid';
import {
  WorkflowComposeRequest,
  WorkflowDependency,
  WorkflowSpec,
  WorkflowStep,
  WorkflowSource,
  OutputPresetId,
  WhatPresetId,
} from '@aso/workflow-contracts';
import { WorkflowCatalogService } from './WorkflowCatalogService';
import { IntentClassification } from '../intent/IntentClassifierService';

export class WorkflowSpecFactory {
  constructor(private readonly catalog: WorkflowCatalogService) {}

  fromComposeRequest(
    request: WorkflowComposeRequest,
    metadata: { userId?: string; sessionId?: string } = {},
  ): WorkflowSpec {
    const steps: WorkflowStep[] = request.steps.map((step) => {
      const what = this.catalog.getWhatPreset(step.whatPresetId);
      const when = this.catalog.getWhenPreset(step.whenPresetId);
      const output = this.catalog.getOutputPreset(step.outputPresetId);
      const displayText = this.catalog.renderStepDisplayText(
        step.whatPresetId,
        step.whenPresetId,
        step.outputPresetId,
      );

      return {
        id: step.id,
        displayText,
        query: {
          presetId: what.id,
          providerRole: what.providerRole,
          tool: what.tool,
          entityType: what.entityType,
          arguments: this.mergeWhenFilters(what.arguments, when.filters),
        },
        whenPresetId: when.id,
        output: {
          presetId: output.id,
          kind: output.kind,
          tool: output.tool,
          artifact: output.artifactKind && output.artifactFormat
            ? {
                kind: output.artifactKind,
                format: output.artifactFormat,
                template: output.template,
              }
            : undefined,
        },
        dependsOn: step.dependsOn ?? [],
      };
    });

    this.validateDependencies(steps);
    const dependencies = this.buildDependencies(steps);
    return {
      schemaVersion: request.schemaVersion,
      id: `wf_${uuidv4()}`,
      source: 'ui_slot',
      displayText: steps.map((step) => step.displayText).join('\n'),
      steps,
      dependencies,
      metadata: {
        ...metadata,
        createdAt: new Date().toISOString(),
      },
    };
  }

  fromClassification(
    classification: IntentClassification,
    text: string,
    metadata: { userId?: string; sessionId?: string } = {},
  ): WorkflowSpec | null {
    const lower = text.toLowerCase();
    const labelTools = classification.label.split('__');
    const outputPresetId = this.outputPresetFromClassification(classification, lower, labelTools);
    const whatPresetId = this.whatPresetFromClassification(classification, lower, labelTools);

    if (!whatPresetId || !outputPresetId) return null;

    const whenPresetId =
      classification.parameters?.dateRange === 'today' ? 'today'
      : classification.parameters?.dateRange === 'this_week' ? 'this_week'
      : classification.parameters?.dateRange === 'this_month' ? 'this_month'
      : classification.parameters?.dateRange === 'last_30_days' ? 'last_30_days'
      : classification.parameters?.dateRange === 'last_7_days' ? 'last_7_days'
      : 'right_now';

    const spec = this.fromComposeRequest(
      {
        schemaVersion: '1.0',
        steps: [{
          id: 'workflow_step_1',
          whatPresetId,
          whenPresetId,
          outputPresetId,
        }],
      },
      metadata,
    );

    return {
      ...spec,
      source: (classification.source ?? 'rules') as WorkflowSource,
      workflowLabel: classification.label,
      confidence: classification.confidence,
      displayText: text,
    };
  }

  private outputPresetFromClassification(
    classification: IntentClassification,
    lower: string,
    labelTools: string[],
  ): OutputPresetId | null {
    if (labelTools.includes('create_internal_email_draft')) return 'email_drafts';
    if (labelTools.includes('create_calendar_event')) return 'calendar_blocks';
    if (labelTools.includes('create_notion_page')) return 'notion_page';
    if (labelTools.includes('send_slack_message')) return 'slack_post';

    if (labelTools.includes('generate_file')) {
      const format = classification.parameters?.format;
      if (format === 'docx') return 'word_summary';
      if (format === 'xlsx') return 'excel_report';
      if (format === 'pdf') return 'pdf_brief';
    }

    // Fallback for rules-only labels or lower-confidence extractions where the
    // action family is known but file format was expressed only in prose.
    return /\bdocx\b|\bword\b/.test(lower) ? 'word_summary'
      : /\bpdf\b|\bbrief\b/.test(lower) ? 'pdf_brief'
      : /\bexcel\b|\bspreadsheet\b|\breport\b/.test(lower) ? 'excel_report'
      : /\bdraft\b/.test(lower) ? 'email_drafts'
      : /\bslack\b|\bpost\b/.test(lower) ? 'slack_post'
      : /\bnotion\b|\bpage\b/.test(lower) ? 'notion_page'
      : /\bschedule\b|\bcalendar\b/.test(lower) ? 'calendar_blocks'
      : null;
  }

  private whatPresetFromClassification(
    classification: IntentClassification,
    lower: string,
    labelTools: string[],
  ): WhatPresetId | null {
    const queryTool = labelTools[0];
    if (queryTool === 'fetch_emails') {
      return this.isGmailAttachmentRequest(classification, lower)
        ? 'gmail_emails_with_attachments'
        : 'unread_gmail_threads';
    }
    if (queryTool === 'fetch_calendar_events') return 'upcoming_google_calendar_events';
    if (queryTool === 'fetch_notion_page') return 'recent_notion_meeting_notes';
    if (queryTool === 'fetch_slack_messages') return 'recent_slack_mentions';

    if (queryTool === 'fetch_entity') {
      if (classification.parameters?.entityType === 'Lead') return 'new_salesforce_leads';
      if (classification.parameters?.entityType === 'Account') return 'key_salesforce_accounts';
      if (classification.parameters?.entityType === 'Case') return 'open_salesforce_cases';
      if (classification.parameters?.entityType === 'Opportunity') {
        if (/\b(no reply|unanswered|no response|hasn.t replied|haven.t replied)\b/.test(lower)) {
          return 'no_reply_7d_deals';
        }
        if (/\b(my|owned by me|assigned to me)\b/.test(lower)) {
          return 'my_active_pipeline_deals';
        }
        if (/\b(team|my team|team-owned|team owned)\b/.test(lower)) {
          return 'team_active_pipeline_deals';
        }
        if (/\bstalled\b/.test(lower)) return 'stalled_high_value_deals';
        if (/\bclosing\b/.test(lower) && /\bmonth\b/.test(lower)) {
          return 'closing_this_month_opportunities';
        }
        return 'warm_salesforce_deals';
      }
    }

    // Fallback for the older hand-written rule labels, which do not always
    // encode the source family as precisely as the trained workflow labels do.
    return classification.parameters?.entityType === 'Opportunity'
      ? (/\b(no reply|unanswered|no response)\b/.test(lower) ? 'no_reply_7d_deals'
        : /\b(my|owned by me|assigned to me)\b/.test(lower) ? 'my_active_pipeline_deals'
        : /\b(team|my team|team-owned|team owned)\b/.test(lower) ? 'team_active_pipeline_deals'
        : /\bstalled\b/.test(lower) ? 'stalled_high_value_deals'
        : 'warm_salesforce_deals')
      : classification.parameters?.entityType === 'Lead' ? 'new_salesforce_leads'
      : classification.parameters?.entityType === 'Account' ? 'key_salesforce_accounts'
      : classification.parameters?.entityType === 'Case' ? 'open_salesforce_cases'
      : /\bemails?\b|\binbox\b/.test(lower)
        ? (this.isGmailAttachmentRequest(classification, lower) ? 'gmail_emails_with_attachments' : 'unread_gmail_threads')
      : /\bcalendar\b|\bmeetings?\b/.test(lower) ? 'upcoming_google_calendar_events'
      : /\bnotion\b/.test(lower) ? 'recent_notion_meeting_notes'
      : /\bslack\b/.test(lower) ? 'recent_slack_mentions'
      : null;
  }

  private isGmailAttachmentRequest(
    classification: IntentClassification,
    lower: string,
  ): boolean {
    const parameters = classification.parameters ?? {};
    if (
      parameters.hasAttachment === true ||
      parameters.hasAttachments === true ||
      parameters.attachment === true ||
      parameters.attachments === true
    ) {
      return true;
    }

    return /\battachments?\b|\battached\b|\bwith\s+(?:files?|docs?|documents?)\b/.test(lower);
  }

  private mergeWhenFilters(
    baseArguments: Record<string, unknown>,
    filters: Record<string, unknown>,
  ): Record<string, unknown> {
    const clone = JSON.parse(JSON.stringify(baseArguments));
    if (Object.keys(filters).length === 0) return clone;

    const input = (clone.input ?? {}) as Record<string, any>;
    input.filters = {
      ...(input.filters ?? {}),
      ...filters,
    };
    clone.input = input;
    return clone;
  }

  private buildDependencies(steps: WorkflowStep[]): WorkflowDependency[] {
    return steps.flatMap((step) =>
      step.dependsOn.map((dependency) => ({
        fromStepId: dependency,
        toStepId: step.id,
      })),
    );
  }

  private validateDependencies(steps: WorkflowStep[]): void {
    const stepIds = new Set(steps.map((step) => step.id));
    for (const step of steps) {
      for (const dependency of step.dependsOn) {
        if (!stepIds.has(dependency)) {
          throw new Error(`Unknown workflow dependency '${dependency}' for step '${step.id}'`);
        }
        if (dependency === step.id) {
          throw new Error(`Workflow step '${step.id}' cannot depend on itself`);
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(steps.map((step) => [step.id, step]));
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error('Workflow dependencies contain a cycle');
      if (visited.has(id)) return;
      visiting.add(id);
      const step = byId.get(id);
      step?.dependsOn.forEach(visit);
      visiting.delete(id);
      visited.add(id);
    };
    steps.forEach((step) => visit(step.id));
  }
}
