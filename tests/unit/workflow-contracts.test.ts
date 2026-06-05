import {
  OUTPUT_PRESET_IDS,
  PROVIDER_ROLE_DEFINITIONS,
  PROVIDER_ROLES,
  COMPOSITE_SHAPES,
  SLOT_OUTPUT_TOOLS,
  SLOT_QUERY_TOOLS,
  WHEN_PRESET_IDS,
  WHAT_PRESET_IDS,
  WORKFLOW_CATALOG,
  WORKFLOW_CATALOG_COUNTS,
  WorkflowComposeRequestSchema,
  assertWorkflowCatalogIntegrity,
} from '@aso/workflow-contracts';

describe('workflow contracts', () => {
  it('keeps the exported catalog internally consistent', () => {
    expect(() => assertWorkflowCatalogIntegrity()).not.toThrow();
    expect(WORKFLOW_CATALOG.what.map((preset) => preset.id)).toEqual(WHAT_PRESET_IDS);
    expect(WORKFLOW_CATALOG.when.map((preset) => preset.id)).toEqual(WHEN_PRESET_IDS);
    expect(WORKFLOW_CATALOG.output.map((preset) => preset.id)).toEqual(OUTPUT_PRESET_IDS);
    expect(WORKFLOW_CATALOG_COUNTS).toEqual({
      what: 14,
      when: 6,
      output: 7,
      combinations: 588,
    });
  });

  it('keeps provider roles derived from the richer runtime definitions', () => {
    expect(PROVIDER_ROLE_DEFINITIONS.fetch_entity).toEqual({
      role: '__CRM__',
      source: 'cache',
    });
    expect(PROVIDER_ROLE_DEFINITIONS.generate_file).toEqual({
      role: '__DESKTOP__',
      source: 'desktop',
    });
    expect(PROVIDER_ROLES.fetch_entity).toBe('__CRM__');
    expect(PROVIDER_ROLES.generate_file).toBe('__DESKTOP__');
  });

  it('covers the full slot-product source/output tool matrix', () => {
    expect(Object.keys(COMPOSITE_SHAPES)).toHaveLength(
      SLOT_QUERY_TOOLS.length * SLOT_OUTPUT_TOOLS.length,
    );
    expect(COMPOSITE_SHAPES.fetch_entity__generate_file).toEqual([
      'fetch_entity',
      'generate_file',
    ]);
    expect(COMPOSITE_SHAPES.fetch_slack_messages__create_notion_page).toEqual([
      'fetch_slack_messages',
      'create_notion_page',
    ]);
  });

  it('rejects unknown preset ids at the shared contract boundary', () => {
    const result = WorkflowComposeRequestSchema.safeParse({
      schemaVersion: '1.0',
      steps: [{
        id: 'workflow_step_1',
        whatPresetId: 'mystery_entities',
        whenPresetId: 'today',
        outputPresetId: 'pdf_brief',
      }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate steps, duplicate dependencies, and dependency cycles', () => {
    const duplicateSteps = WorkflowComposeRequestSchema.safeParse({
      schemaVersion: '1.0',
      steps: [
        {
          id: 'workflow_step_1',
          whatPresetId: 'warm_salesforce_deals',
          whenPresetId: 'today',
          outputPresetId: 'pdf_brief',
        },
        {
          id: 'workflow_step_1',
          whatPresetId: 'recent_slack_mentions',
          whenPresetId: 'last_7_days',
          outputPresetId: 'excel_report',
          dependsOn: ['workflow_step_1', 'workflow_step_1'],
        },
      ],
    });

    expect(duplicateSteps.success).toBe(false);

    const cycle = WorkflowComposeRequestSchema.safeParse({
      schemaVersion: '1.0',
      steps: [
        {
          id: 'workflow_step_1',
          whatPresetId: 'warm_salesforce_deals',
          whenPresetId: 'today',
          outputPresetId: 'pdf_brief',
          dependsOn: ['workflow_step_2'],
        },
        {
          id: 'workflow_step_2',
          whatPresetId: 'recent_slack_mentions',
          whenPresetId: 'last_7_days',
          outputPresetId: 'excel_report',
          dependsOn: ['workflow_step_1'],
        },
      ],
    });

    expect(cycle.success).toBe(false);
  });
});
