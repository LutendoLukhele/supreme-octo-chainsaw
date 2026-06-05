import { WorkflowCatalogService } from '../../src/services/workflow/WorkflowCatalogService';
import { WorkflowSpecFactory } from '../../src/services/workflow/WorkflowSpecFactory';

describe('WorkflowSpecFactory', () => {
  const factory = new WorkflowSpecFactory(new WorkflowCatalogService());

  it('renders prose from typed slot selections', () => {
    const spec = factory.fromComposeRequest({
      schemaVersion: '1.0',
      steps: [{
        id: 'workflow_step_1',
        whatPresetId: 'warm_salesforce_deals',
        whenPresetId: 'today',
        outputPresetId: 'pdf_brief',
      }],
    });

    expect(spec.displayText).toContain('warm Salesforce deals');
    expect(spec.displayText).toContain('generate a PDF executive brief');
    expect(spec.steps[0].query.arguments).toMatchObject({
      input: {
        filters: {
          preset: 'warm_active_pipeline',
          dateRange: 'today',
        },
      },
    });
  });

  it('converges a recognized text classification onto the same workflow model', () => {
    const spec = factory.fromClassification(
      {
        label: 'fetch_entity__generate_file',
        confidence: 0.94,
        source: 'rules',
        parameters: {
          entityType: 'Opportunity',
          dateRange: 'today',
        },
      },
      'Find deals today and generate a PDF brief',
    );

    expect(spec).not.toBeNull();
    expect(spec?.source).toBe('rules');
    expect(spec?.steps[0].query.presetId).toBe('warm_salesforce_deals');
    expect(spec?.steps[0].output.presetId).toBe('pdf_brief');
  });

  it('routes Word requests onto the DOCX summary preset', () => {
    const spec = factory.fromClassification(
      {
        label: 'fetch_entity__generate_file',
        confidence: 0.94,
        source: 'rules',
        parameters: {
          entityType: 'Opportunity',
          dateRange: 'today',
        },
      },
      'Find deals today and generate a Word summary document',
    );

    expect(spec).not.toBeNull();
    expect(spec?.steps[0].output.presetId).toBe('word_summary');
    expect(spec?.steps[0].output.artifact).toMatchObject({
      kind: 'summary_document',
      format: 'docx',
    });
  });

  it('uses the classified workflow label before prose heuristics for typed product outputs', () => {
    const spec = factory.fromClassification(
      {
        label: 'fetch_slack_messages__create_internal_email_draft',
        confidence: 0.99,
        source: 'onnx',
        parameters: {},
      },
      'Take recent mentions and prepare the follow-up package',
    );

    expect(spec).not.toBeNull();
    expect(spec?.source).toBe('onnx');
    expect(spec?.steps[0].query.presetId).toBe('recent_slack_mentions');
    expect(spec?.steps[0].output.presetId).toBe('email_drafts');
  });

  it('uses extracted file format when a generate-file label carries no prose clue', () => {
    const spec = factory.fromClassification(
      {
        label: 'fetch_entity__generate_file',
        confidence: 0.99,
        source: 'onnx',
        parameters: {
          entityType: 'Opportunity',
          format: 'docx',
        },
      },
      'Package the warm deals for leadership',
    );

    expect(spec).not.toBeNull();
    expect(spec?.steps[0].output.presetId).toBe('word_summary');
  });

  it('routes free-text Gmail attachment requests onto the attachment preset', () => {
    const spec = factory.fromClassification(
      {
        label: 'fetch_emails__generate_file',
        confidence: 0.99,
        source: 'onnx',
        parameters: {
          dateRange: 'today',
          format: 'docx',
        },
      },
      'Show me Gmail emails with attachments from the inbox today and generate a Word summary document',
    );

    expect(spec).not.toBeNull();
    expect(spec?.steps[0].query.presetId).toBe('gmail_emails_with_attachments');
    expect(spec?.steps[0].whenPresetId).toBe('today');
    expect(spec?.steps[0].query.arguments).toMatchObject({
      input: {
        filters: {
          hasAttachment: true,
          labels: ['INBOX'],
          dateRange: 'today',
        },
      },
    });
    expect(spec?.steps[0].output.presetId).toBe('word_summary');
  });

  it('routes extracted Gmail attachment slots onto the attachment preset', () => {
    const spec = factory.fromClassification(
      {
        label: 'fetch_emails__generate_file',
        confidence: 0.99,
        source: 'onnx',
        parameters: {
          hasAttachment: true,
          format: 'xlsx',
        },
      },
      'Find inbox emails and generate a report',
    );

    expect(spec).not.toBeNull();
    expect(spec?.steps[0].query.presetId).toBe('gmail_emails_with_attachments');
    expect(spec?.steps[0].output.presetId).toBe('excel_report');
  });
});
