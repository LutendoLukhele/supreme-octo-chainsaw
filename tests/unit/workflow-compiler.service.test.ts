import {
  OUTPUT_PRESETS,
  WHEN_PRESETS,
  WHAT_PRESETS,
} from '@aso/workflow-contracts';
import { WorkflowCatalogService } from '../../src/services/workflow/WorkflowCatalogService';
import { WorkflowSpecFactory } from '../../src/services/workflow/WorkflowSpecFactory';
import { WorkflowCompilerService } from '../../src/services/workflow/WorkflowCompilerService';

describe('workflow compilation', () => {
  const catalog = new WorkflowCatalogService();
  const factory = new WorkflowSpecFactory(catalog);
  const compiler = new WorkflowCompilerService();

  it('compiles every current slot combination deterministically', () => {
    for (const what of WHAT_PRESETS) {
      for (const when of WHEN_PRESETS) {
        for (const output of OUTPUT_PRESETS) {
          const spec = factory.fromComposeRequest({
            schemaVersion: '1.0',
            steps: [{
              id: 'workflow_step_1',
              whatPresetId: what.id,
              whenPresetId: when.id,
              outputPresetId: output.id,
            }],
          });
          const compiled = compiler.compile(spec);
          expect(compiled.actionPlan.length).toBe(2);
          expect(compiled.actionPlan[0].tool).toBe(what.tool);
          expect(compiled.actionPlan[1].tool).toBeDefined();
        }
      }
    }
  });

  it('preserves explicit dependencies across workflow steps', () => {
    const spec = factory.fromComposeRequest({
      schemaVersion: '1.0',
      steps: [
        {
          id: 'workflow_step_1',
          whatPresetId: 'warm_salesforce_deals',
          whenPresetId: 'today',
          outputPresetId: 'pdf_brief',
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

    const compiled = compiler.compile(spec);
    const secondQuery = compiled.actionPlan.find((step) => step.workflowStepId === 'workflow_step_2' && step.tool === 'fetch_slack_messages');
    const firstTerminal = compiled.actionPlan.find((step) => step.workflowStepId === 'workflow_step_1' && step.tool === 'generate_file');
    expect(secondQuery?.dependsOn).toEqual([firstTerminal?.id]);
  });

  it('creates artifact specs for file outputs and internal email drafts', () => {
    const spec = factory.fromComposeRequest({
      schemaVersion: '1.0',
      steps: [
        {
          id: 'workflow_step_1',
          whatPresetId: 'warm_salesforce_deals',
          whenPresetId: 'today',
          outputPresetId: 'pdf_brief',
        },
        {
          id: 'workflow_step_2',
          whatPresetId: 'warm_salesforce_deals',
          whenPresetId: 'today',
          outputPresetId: 'email_drafts',
        },
      ],
    });

    const compiled = compiler.compile(spec);
    expect(compiled.artifactSpecs.map((artifact) => artifact.kind)).toEqual([
      'executive_brief',
      'email_draft',
    ]);
  });

  it('compiles DOCX summary outputs into native document artifacts', () => {
    const spec = factory.fromComposeRequest({
      schemaVersion: '1.0',
      steps: [{
        id: 'workflow_step_1',
        whatPresetId: 'warm_salesforce_deals',
        whenPresetId: 'today',
        outputPresetId: 'word_summary',
      }],
    });

    const compiled = compiler.compile(spec);
    expect(compiled.artifactSpecs[0]).toMatchObject({
      kind: 'summary_document',
      format: 'docx',
      title: 'Word Summary',
    });
    expect(compiled.actionPlan[1]).toMatchObject({
      tool: 'generate_file',
    });
  });
});
