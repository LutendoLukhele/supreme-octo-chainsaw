import { z } from 'zod';

export const WORKFLOW_SCHEMA_VERSION = '1.0' as const;
export const WORKFLOW_CATALOG_VERSION = '1.2' as const;

export type WorkflowSource = 'ui_slot' | 'rules' | 'onnx' | 'llm';
export type ProviderRole =
  | '__CRM__'
  | '__EMAIL__'
  | '__CALENDAR__'
  | '__NOTES__'
  | '__SLACK__'
  | '__DESKTOP__';
export type ProviderSource = 'cache' | 'action' | 'desktop';

export type WorkflowOutputKind =
  | 'artifact'
  | 'internal_email_drafts'
  | 'calendar_blocks'
  | 'notion_page'
  | 'slack_post';

export type ArtifactKind = 'executive_brief' | 'report' | 'summary_document' | 'email_draft';
export type ArtifactFormat = 'pdf' | 'xlsx' | 'docx' | 'internal';
export type ArtifactStatus = 'compiled' | 'rendering' | 'ready' | 'error';
export type DocumentGenerationMode = 'local' | 'server' | 'unknown';

export const WHAT_PRESET_IDS = [
  'warm_salesforce_deals',
  'stalled_high_value_deals',
  'no_reply_7d_deals',
  'my_active_pipeline_deals',
  'team_active_pipeline_deals',
  'closing_this_month_opportunities',
  'new_salesforce_leads',
  'open_salesforce_cases',
  'key_salesforce_accounts',
  'unread_gmail_threads',
  'gmail_emails_with_attachments',
  'upcoming_google_calendar_events',
  'recent_notion_meeting_notes',
  'recent_slack_mentions',
] as const;

export const WHEN_PRESET_IDS = [
  'right_now',
  'today',
  'this_week',
  'this_month',
  'last_30_days',
  'last_7_days',
] as const;

export const OUTPUT_PRESET_IDS = [
  'email_drafts',
  'calendar_blocks',
  'notion_page',
  'slack_post',
  'excel_report',
  'pdf_brief',
  'word_summary',
] as const;

export type WhatPresetId = typeof WHAT_PRESET_IDS[number];
export type WhenPresetId = typeof WHEN_PRESET_IDS[number];
export type OutputPresetId = typeof OUTPUT_PRESET_IDS[number];

export interface WhatPresetDefinition {
  id: WhatPresetId;
  label: string;
  displayNoun: string;
  providerRole: ProviderRole;
  tool: string;
  entityType?: string;
  arguments: Record<string, unknown>;
}

export interface ProviderRoleDefinition {
  role: ProviderRole;
  source: ProviderSource;
}

export interface WhenPresetDefinition {
  id: WhenPresetId;
  label: string;
  displayPhrase: string;
  filters: Record<string, unknown>;
}

export interface OutputPresetDefinition {
  id: OutputPresetId;
  label: string;
  displayPhrase: string;
  kind: WorkflowOutputKind;
  tool?: string;
  artifactKind?: ArtifactKind;
  artifactFormat?: ArtifactFormat;
  template?: string;
}

export interface WorkflowComposeStepRequest {
  id: string;
  whatPresetId: WhatPresetId;
  whenPresetId: WhenPresetId;
  outputPresetId: OutputPresetId;
  dependsOn?: string[];
}

export interface WorkflowComposeRequest {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  steps: WorkflowComposeStepRequest[];
}

export interface WorkflowDependency {
  fromStepId: string;
  toStepId: string;
}

export interface WorkflowQuery {
  presetId: WhatPresetId;
  providerRole: ProviderRole;
  tool: string;
  entityType?: string;
  arguments: Record<string, unknown>;
}

export interface WorkflowOutput {
  presetId: OutputPresetId;
  kind: WorkflowOutputKind;
  tool?: string;
  artifact?: {
    kind: ArtifactKind;
    format: ArtifactFormat;
    template?: string;
  };
}

export interface WorkflowStep {
  id: string;
  displayText: string;
  query: WorkflowQuery;
  whenPresetId: WhenPresetId;
  output: WorkflowOutput;
  dependsOn: string[];
}

export interface WorkflowSpec {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  id: string;
  source: WorkflowSource;
  displayText: string;
  workflowLabel?: string;
  confidence?: number;
  steps: WorkflowStep[];
  dependencies: WorkflowDependency[];
  metadata: {
    userId?: string;
    sessionId?: string;
    createdAt: string;
  };
}

export interface CompiledWorkflowActionNode {
  id: string;
  workflowStepId: string;
  tool: string;
  intent: string;
  arguments: Record<string, unknown>;
  dependsOn: string[];
  artifactSpecId?: string;
}

export interface CompiledWorkflowPlan {
  workflowId: string;
  nodes: CompiledWorkflowActionNode[];
  edges: WorkflowDependency[];
}

export interface ArtifactSection {
  kind: 'summary' | 'table' | 'recommendations' | 'drafts';
  title: string;
}

export interface ArtifactSpec {
  id: string;
  workflowId: string;
  workflowStepId: string;
  kind: ArtifactKind;
  format: ArtifactFormat;
  title: string;
  sections: ArtifactSection[];
  bindings: Record<string, unknown>;
  status: ArtifactStatus;
  renderedPath?: string;
  renderedFilename?: string;
  byteLength?: number;
  generationMode?: DocumentGenerationMode;
  previewRows?: string[][];
  previewText?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GeneratedDocumentArtifact {
  filename: string;
  format: Exclude<ArtifactFormat, 'internal'>;
  filePath?: string;
  fileUrl?: string;
  generationMode: DocumentGenerationMode;
  previewRows?: string[][];
  previewText?: string;
  fileBytesBase64?: string;
}

export const WorkflowComposeStepRequestSchema = z.object({
  id: z.string().min(1),
  whatPresetId: z.enum(WHAT_PRESET_IDS),
  whenPresetId: z.enum(WHEN_PRESET_IDS),
  outputPresetId: z.enum(OUTPUT_PRESET_IDS),
  dependsOn: z.array(z.string().min(1)).optional(),
});

export const WorkflowComposeRequestSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  steps: z.array(WorkflowComposeStepRequestSchema).min(1),
}).superRefine((request, ctx) => {
  const stepIds = request.steps.map((step) => step.id);
  const knownStepIds = new Set(stepIds);
  const duplicateStepIds = stepIds.filter((id, index) => stepIds.indexOf(id) !== index);

  duplicateStepIds.forEach((id) => {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Duplicate workflow step id: ${id}`,
      path: ['steps'],
    });
  });

  request.steps.forEach((step, stepIndex) => {
    const seenDependencies = new Set<string>();
    step.dependsOn?.forEach((dependencyId, dependencyIndex) => {
      if (!knownStepIds.has(dependencyId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown workflow dependency '${dependencyId}' for step '${step.id}'`,
          path: ['steps', stepIndex, 'dependsOn', dependencyIndex],
        });
      }
      if (dependencyId === step.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Workflow step '${step.id}' cannot depend on itself`,
          path: ['steps', stepIndex, 'dependsOn', dependencyIndex],
        });
      }
      if (seenDependencies.has(dependencyId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate workflow dependency '${dependencyId}' for step '${step.id}'`,
          path: ['steps', stepIndex, 'dependsOn', dependencyIndex],
        });
      }
      seenDependencies.add(dependencyId);
    });
  });

  const dependencyMap = new Map(
    request.steps.map((step) => [step.id, step.dependsOn ?? []]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const hasCycle = (dependencyMap.get(id) ?? []).some((dependencyId) =>
      dependencyMap.has(dependencyId) ? visit(dependencyId) : false,
    );
    visiting.delete(id);
    visited.add(id);
    return hasCycle;
  };

  if (request.steps.some((step) => visit(step.id))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Workflow dependencies contain a cycle',
      path: ['steps'],
    });
  }
});

export const WorkflowDependencySchema = z.object({
  fromStepId: z.string().min(1),
  toStepId: z.string().min(1),
});

export const WorkflowOutputSchema = z.object({
  presetId: z.enum(OUTPUT_PRESET_IDS),
  kind: z.enum(['artifact', 'internal_email_drafts', 'calendar_blocks', 'notion_page', 'slack_post']),
  tool: z.string().optional(),
  artifact: z.object({
    kind: z.enum(['executive_brief', 'report', 'summary_document', 'email_draft']),
    format: z.enum(['pdf', 'xlsx', 'docx', 'internal']),
    template: z.string().optional(),
  }).optional(),
});

export const WorkflowStepSchema = z.object({
  id: z.string().min(1),
  displayText: z.string(),
  query: z.object({
    presetId: z.enum(WHAT_PRESET_IDS),
    providerRole: z.enum(['__CRM__', '__EMAIL__', '__CALENDAR__', '__NOTES__', '__SLACK__', '__DESKTOP__']),
    tool: z.string().min(1),
    entityType: z.string().optional(),
    arguments: z.record(z.unknown()),
  }),
  whenPresetId: z.enum(WHEN_PRESET_IDS),
  output: WorkflowOutputSchema,
  dependsOn: z.array(z.string()),
});

export const WorkflowSpecSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  id: z.string().min(1),
  source: z.enum(['ui_slot', 'rules', 'onnx', 'llm']),
  displayText: z.string(),
  workflowLabel: z.string().optional(),
  confidence: z.number().optional(),
  steps: z.array(WorkflowStepSchema).min(1),
  dependencies: z.array(WorkflowDependencySchema),
  metadata: z.object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    createdAt: z.string(),
  }),
});

export const CompiledWorkflowPlanSchema = z.object({
  workflowId: z.string().min(1),
  nodes: z.array(z.object({
    id: z.string().min(1),
    workflowStepId: z.string().min(1),
    tool: z.string().min(1),
    intent: z.string(),
    arguments: z.record(z.unknown()),
    dependsOn: z.array(z.string()),
    artifactSpecId: z.string().optional(),
  })),
  edges: z.array(WorkflowDependencySchema),
});

export const ArtifactSpecSchema = z.object({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  workflowStepId: z.string().min(1),
  kind: z.enum(['executive_brief', 'report', 'summary_document', 'email_draft']),
  format: z.enum(['pdf', 'xlsx', 'docx', 'internal']),
  title: z.string(),
  sections: z.array(z.object({
    kind: z.enum(['summary', 'table', 'recommendations', 'drafts']),
    title: z.string(),
  })),
  bindings: z.record(z.unknown()),
  status: z.enum(['compiled', 'rendering', 'ready', 'error']),
  renderedPath: z.string().optional(),
  renderedFilename: z.string().optional(),
  byteLength: z.number().int().nonnegative().optional(),
  generationMode: z.enum(['local', 'server', 'unknown']).optional(),
  previewRows: z.array(z.array(z.string())).optional(),
  previewText: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const GeneratedDocumentArtifactSchema = z.object({
  filename: z.string().min(1),
  format: z.enum(['pdf', 'xlsx', 'docx']),
  filePath: z.string().optional(),
  fileUrl: z.string().optional(),
  generationMode: z.enum(['local', 'server', 'unknown']),
  previewRows: z.array(z.array(z.string())).optional(),
  previewText: z.string().optional(),
  fileBytesBase64: z.string().optional(),
});

export const WHAT_PRESETS: readonly WhatPresetDefinition[] = [
  {
    id: 'warm_salesforce_deals',
    label: 'Warm deals',
    displayNoun: 'warm Salesforce deals in active pipeline stages',
    providerRole: '__CRM__',
    tool: 'fetch_entity',
    entityType: 'Opportunity',
    arguments: {
      input: {
        operation: 'fetch',
        entityType: 'Opportunity',
        filters: {
          preset: 'warm_active_pipeline',
        },
        format: 'detailed',
      },
    },
  },
  {
    id: 'stalled_high_value_deals',
    label: 'Stalled > R100k',
    displayNoun: 'stalled Salesforce deals over R100k',
    providerRole: '__CRM__',
    tool: 'fetch_entity',
    entityType: 'Opportunity',
    arguments: {
      input: {
        operation: 'fetch',
        entityType: 'Opportunity',
        filters: {
          preset: 'stalled_over_100k',
        },
        format: 'detailed',
      },
    },
  },
  {
    id: 'no_reply_7d_deals',
    label: 'No reply 7d',
    displayNoun: 'Salesforce deals with no reply in 7 days',
    providerRole: '__CRM__',
    tool: 'fetch_entity',
    entityType: 'Opportunity',
    arguments: {
      input: {
        operation: 'fetch',
        entityType: 'Opportunity',
        filters: {
          preset: 'no_reply_7_days',
        },
        format: 'detailed',
      },
    },
  },
  {
    id: 'my_active_pipeline_deals',
    label: 'My pipeline',
    displayNoun: 'Salesforce deals owned by me in active pipeline stages',
    providerRole: '__CRM__',
    tool: 'fetch_entity',
    entityType: 'Opportunity',
    arguments: {
      input: {
        operation: 'fetch',
        entityType: 'Opportunity',
        filters: {
          preset: 'owned_by_me_active_pipeline',
        },
        format: 'detailed',
      },
    },
  },
  {
    id: 'team_active_pipeline_deals',
    label: 'Team pipeline',
    displayNoun: 'team-owned Salesforce deals in active pipeline stages',
    providerRole: '__CRM__',
    tool: 'fetch_entity',
    entityType: 'Opportunity',
    arguments: {
      input: {
        operation: 'fetch',
        entityType: 'Opportunity',
        filters: {
          preset: 'team_active_pipeline',
        },
        format: 'detailed',
      },
    },
  },
  {
    id: 'closing_this_month_opportunities',
    label: 'Closing this month',
    displayNoun: 'Salesforce opportunities with close dates this month',
    providerRole: '__CRM__',
    tool: 'fetch_entity',
    entityType: 'Opportunity',
    arguments: {
      input: {
        operation: 'fetch',
        entityType: 'Opportunity',
        filters: {
          preset: 'closing_this_month',
        },
        format: 'detailed',
      },
    },
  },
  {
    id: 'new_salesforce_leads',
    label: 'New leads',
    displayNoun: 'new Salesforce leads created recently',
    providerRole: '__CRM__',
    tool: 'fetch_entity',
    entityType: 'Lead',
    arguments: {
      input: {
        operation: 'fetch',
        entityType: 'Lead',
        filters: {
          preset: 'recent_new_leads',
        },
        format: 'detailed',
      },
    },
  },
  {
    id: 'open_salesforce_cases',
    label: 'Open cases',
    displayNoun: 'open Salesforce support cases',
    providerRole: '__CRM__',
    tool: 'fetch_entity',
    entityType: 'Case',
    arguments: {
      input: {
        operation: 'fetch',
        entityType: 'Case',
        filters: {
          preset: 'open_cases',
        },
        format: 'detailed',
      },
    },
  },
  {
    id: 'key_salesforce_accounts',
    label: 'Key accounts',
    displayNoun: 'top Salesforce accounts by deal value',
    providerRole: '__CRM__',
    tool: 'fetch_entity',
    entityType: 'Account',
    arguments: {
      input: {
        operation: 'fetch',
        entityType: 'Account',
        filters: {
          preset: 'top_by_deal_value',
        },
        format: 'detailed',
      },
    },
  },
  {
    id: 'unread_gmail_threads',
    label: 'Unread threads',
    displayNoun: 'unread Gmail threads excluding promotions',
    providerRole: '__EMAIL__',
    tool: 'fetch_emails',
    arguments: {
      input: {
        operation: 'fetch',
        filters: {
          isRead: false,
          excludeCategories: ['Promotions'],
        },
      },
    },
  },
  {
    id: 'gmail_emails_with_attachments',
    label: 'Emails with attachments',
    displayNoun: 'Gmail emails with attachments from the inbox',
    providerRole: '__EMAIL__',
    tool: 'fetch_emails',
    arguments: {
      input: {
        operation: 'fetch',
        filters: {
          hasAttachment: true,
          labels: ['INBOX'],
        },
      },
    },
  },
  {
    id: 'upcoming_google_calendar_events',
    label: 'Upcoming calls',
    displayNoun: 'upcoming Google Calendar events in the next 7 days',
    providerRole: '__CALENDAR__',
    tool: 'fetch_calendar_events',
    arguments: {
      input: {
        operation: 'fetch_list',
        filters: {
          preset: 'next_7_days',
        },
      },
    },
  },
  {
    id: 'recent_notion_meeting_notes',
    label: 'Meeting notes',
    displayNoun: 'recent Notion meeting note pages',
    providerRole: '__NOTES__',
    tool: 'fetch_notion_page',
    arguments: {
      input: {
        operation: 'fetch_database',
        entityType: 'Page',
        filters: {
          preset: 'recent_meeting_notes',
        },
      },
    },
  },
  {
    id: 'recent_slack_mentions',
    label: 'Slack mentions',
    displayNoun: 'recent Slack messages that mention me or my deals',
    providerRole: '__SLACK__',
    tool: 'fetch_slack_messages',
    arguments: {
      input: {
        operation: 'fetch',
        channel: '{{PLACEHOLDER_channel}}',
        filters: {
          preset: 'mentions_me_or_my_deals',
        },
      },
    },
  },
] as const;

export const WHEN_PRESETS: readonly WhenPresetDefinition[] = [
  { id: 'right_now', label: 'Any time', displayPhrase: '', filters: {} },
  { id: 'today', label: 'Today', displayPhrase: 'due today', filters: { dateRange: 'today' } },
  { id: 'this_week', label: 'This week', displayPhrase: 'due this week', filters: { dateRange: 'this_week' } },
  { id: 'this_month', label: 'This month', displayPhrase: 'due this month', filters: { dateRange: 'this_month' } },
  { id: 'last_30_days', label: 'Last 30 days', displayPhrase: 'from the last 30 days', filters: { dateRange: 'last_30_days' } },
  { id: 'last_7_days', label: 'Last 7 days', displayPhrase: 'from the last 7 days', filters: { dateRange: 'last_7_days' } },
] as const;

export const OUTPUT_PRESETS: readonly OutputPresetDefinition[] = [
  {
    id: 'email_drafts',
    label: 'Email drafts',
    displayPhrase: 'draft personalised follow-up emails for each',
    kind: 'internal_email_drafts',
    artifactKind: 'email_draft',
    artifactFormat: 'internal',
    template: 'follow_up_email_drafts',
  },
  {
    id: 'calendar_blocks',
    label: 'Calendar blocks',
    displayPhrase: 'schedule review calls on Google Calendar',
    kind: 'calendar_blocks',
    tool: 'create_calendar_event',
  },
  {
    id: 'notion_page',
    label: 'Notion page',
    displayPhrase: 'create a structured Notion summary page',
    kind: 'notion_page',
    tool: 'create_notion_page',
  },
  {
    id: 'slack_post',
    label: 'Slack post',
    displayPhrase: 'post a concise pipeline update to Slack',
    kind: 'slack_post',
    tool: 'send_slack_message',
  },
  {
    id: 'excel_report',
    label: 'Excel report',
    displayPhrase: 'generate an Excel report with full data',
    kind: 'artifact',
    tool: 'generate_file',
    artifactKind: 'report',
    artifactFormat: 'xlsx',
    template: 'full_data_report',
  },
  {
    id: 'pdf_brief',
    label: 'PDF brief',
    displayPhrase: 'generate a PDF executive brief',
    kind: 'artifact',
    tool: 'generate_file',
    artifactKind: 'executive_brief',
    artifactFormat: 'pdf',
    template: 'executive_brief',
  },
  {
    id: 'word_summary',
    label: 'Word document',
    displayPhrase: 'generate a Word summary document',
    kind: 'artifact',
    tool: 'generate_file',
    artifactKind: 'summary_document',
    artifactFormat: 'docx',
    template: 'summary_document',
  },
] as const;

export const WORKFLOW_CATALOG = Object.freeze({
  schemaVersion: WORKFLOW_SCHEMA_VERSION,
  catalogVersion: WORKFLOW_CATALOG_VERSION,
  what: WHAT_PRESETS,
  when: WHEN_PRESETS,
  output: OUTPUT_PRESETS,
});

export const WORKFLOW_CATALOG_COUNTS = Object.freeze({
  what: WHAT_PRESETS.length,
  when: WHEN_PRESETS.length,
  output: OUTPUT_PRESETS.length,
  combinations: WHAT_PRESETS.length * WHEN_PRESETS.length * OUTPUT_PRESETS.length,
});

export function assertWorkflowCatalogIntegrity(): void {
  assertExactCatalogIds('what', WHAT_PRESETS.map((preset) => preset.id), WHAT_PRESET_IDS);
  assertExactCatalogIds('when', WHEN_PRESETS.map((preset) => preset.id), WHEN_PRESET_IDS);
  assertExactCatalogIds('output', OUTPUT_PRESETS.map((preset) => preset.id), OUTPUT_PRESET_IDS);
}

function assertExactCatalogIds(
  label: string,
  actualIds: readonly string[],
  expectedIds: readonly string[],
): void {
  const actual = new Set(actualIds);
  const expected = new Set(expectedIds);
  const duplicateCount = actualIds.length - actual.size;
  const missing = expectedIds.filter((id) => !actual.has(id));
  const unexpected = actualIds.filter((id) => !expected.has(id));

  if (duplicateCount || missing.length || unexpected.length) {
    throw new Error(
      `Invalid ${label} preset catalog. Duplicates: ${duplicateCount}. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}.`,
    );
  }
}

assertWorkflowCatalogIntegrity();

export const PROVIDER_ROLE_DEFINITIONS: Record<string, ProviderRoleDefinition> = {
  fetch_entity: { role: '__CRM__', source: 'cache' },
  create_entity: { role: '__CRM__', source: 'action' },
  update_entity: { role: '__CRM__', source: 'action' },
  fetch_emails: { role: '__EMAIL__', source: 'cache' },
  send_email: { role: '__EMAIL__', source: 'action' },
  fetch_calendar_events: { role: '__CALENDAR__', source: 'cache' },
  create_calendar_event: { role: '__CALENDAR__', source: 'action' },
  fetch_notion_page: { role: '__NOTES__', source: 'cache' },
  create_notion_page: { role: '__NOTES__', source: 'action' },
  fetch_slack_messages: { role: '__SLACK__', source: 'cache' },
  send_slack_message: { role: '__SLACK__', source: 'action' },
  generate_file: { role: '__DESKTOP__', source: 'desktop' },
  create_internal_email_draft: { role: '__DESKTOP__', source: 'desktop' },
};

export const PROVIDER_ROLES: Record<string, ProviderRole> = Object.fromEntries(
  Object.entries(PROVIDER_ROLE_DEFINITIONS).map(([tool, definition]) => [tool, definition.role]),
);

export const PARAM_MAPPINGS = {
  fetch_entity: {
    entityType: { fromSlot: 'ENTITY_TYPE', normalize: true },
    'filters.dateRange': { fromSlot: 'DATE', normalize: false },
  },
  fetch_emails: {
    'filters.sender': { fromSlot: 'PERSON', normalize: false },
    'filters.subject': { fromSlot: 'SUBJECT', normalize: false },
    'filters.dateRange': { fromSlot: 'DATE', normalize: false },
  },
  fetch_calendar_events: {
    dateRange: { fromSlot: 'DATE', normalize: false },
  },
  fetch_notion_page: {
    query: { fromSlot: 'SUBJECT', normalize: false },
  },
  fetch_slack_messages: {
    channel: { fromSlot: 'CHANNEL', normalize: false },
  },
  send_slack_message: {
    channel: { fromSlot: 'CHANNEL', normalize: false },
  },
  create_calendar_event: {
    date: { fromSlot: 'DATE', normalize: false },
  },
  generate_file: {
    format: { fromSlot: 'FORMAT', normalize: true },
    template: { fromSlot: 'TEMPLATE', normalize: false },
  },
} as const;

export const ENTITY_NORMALIZERS: Record<string, string> = {
  leads: 'Lead',
  contacts: 'Contact',
  accounts: 'Account',
  opportunities: 'Opportunity',
  deals: 'Opportunity',
  cases: 'Case',
  spreadsheet: 'xlsx',
  excel: 'xlsx',
  word: 'docx',
  docx: 'docx',
  pdf: 'pdf',
};

export const SLOT_QUERY_TOOLS = [
  'fetch_entity',
  'fetch_emails',
  'fetch_calendar_events',
  'fetch_notion_page',
  'fetch_slack_messages',
] as const;

export const SLOT_OUTPUT_TOOLS = [
  'create_internal_email_draft',
  'create_calendar_event',
  'create_notion_page',
  'send_slack_message',
  'generate_file',
] as const;

export const COMPOSITE_SHAPES: Record<string, readonly string[]> = Object.freeze(
  Object.fromEntries(
    SLOT_QUERY_TOOLS.flatMap((queryTool) =>
      SLOT_OUTPUT_TOOLS.map((outputTool) => [
        `${queryTool}__${outputTool}`,
        [queryTool, outputTool] as const,
      ]),
    ),
  ),
);
