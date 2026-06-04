import path from 'path';
import { IntentClassifierService } from '../services/intent/IntentClassifierService';
import { WorkflowCatalogService } from '../services/workflow/WorkflowCatalogService';
import { WorkflowSpecFactory } from '../services/workflow/WorkflowSpecFactory';

const intentModelDir = process.env.ML_INTENT_MODEL_DIR
  ?? path.join(process.cwd(), '.data', 'model-bundles', 'current', 'models', 'intent_classifier');
const nerModelDir = process.env.ML_NER_MODEL_DIR
  ?? path.join(process.cwd(), '.data', 'model-bundles', 'current', 'models', 'ner_extractor');

const samples = [
  'Find warm Salesforce deals due today and draft personalised follow-up emails for each',
  'Find recent Slack messages that mention me or my deals from the last 7 days and generate a PDF executive brief',
  'Find upcoming Google Calendar events due this week and create a structured Notion summary page',
];

async function main(): Promise<void> {
  const classifier = new IntentClassifierService();
  await classifier.loadONNXModel(intentModelDir, nerModelDir);

  const factory = new WorkflowSpecFactory(new WorkflowCatalogService());
  let failures = 0;

  for (const sample of samples) {
    const classification = await classifier.classifyKnownWorkflow(sample);
    const spec = classification
      ? factory.fromClassification(classification, sample)
      : null;

    const result = {
      sample,
      classification,
      workflow: spec
        ? {
            source: spec.source,
            label: spec.workflowLabel,
            whatPresetId: spec.steps[0].query.presetId,
            whenPresetId: spec.steps[0].whenPresetId,
            outputPresetId: spec.steps[0].output.presetId,
          }
        : null,
    };
    console.log(JSON.stringify(result, null, 2));

    if (!classification || classification.source !== 'onnx' || !spec) {
      failures += 1;
    }
  }

  if (failures > 0) {
    throw new Error(`ONNX runtime validation failed for ${failures}/${samples.length} samples`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
