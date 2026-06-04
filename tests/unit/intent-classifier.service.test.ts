import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  IntentClassifierService,
  resolveClassifierModelDirs,
} from '../../src/services/intent/IntentClassifierService';

describe('IntentClassifierService', () => {
  it('classifies qualified recent-email fetches by rules', () => {
    const classifier = new IntentClassifierService();
    const classification = classifier.classify(
      'Find my 5 most recent customer emails and extract sender subject and urgency',
    );

    expect(classification).toMatchObject({
      label: 'fetch_emails',
      source: 'rules',
    });
  });

  it('does not reinterpret relative date windows as row limits', async () => {
    const classifier = new IntentClassifierService();
    const classification = await classifier.classifyKnownWorkflow(
      'Find Salesforce deals from the last 7 days',
    );

    expect(classification?.parameters).toMatchObject({
      dateRange: 'last_7_days',
    });
    expect(classification?.parameters.limit).toBeUndefined();
  });

  it('resolves the packaged underscore model path before the legacy hyphen path', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aso-model-dirs-'));
    try {
      const packagedIntentDir = path.join(cwd, '.data', 'model-bundles', 'current', 'models', 'intent_classifier');
      const legacyIntentDir = path.join(cwd, 'models', 'intent-classifier');
      fs.mkdirSync(packagedIntentDir, { recursive: true });
      fs.mkdirSync(legacyIntentDir, { recursive: true });
      fs.writeFileSync(path.join(packagedIntentDir, 'model.onnx'), '');
      fs.writeFileSync(path.join(legacyIntentDir, 'model.onnx'), '');

      const dirs = resolveClassifierModelDirs(cwd, {});

      expect(dirs.intentModelDir).toBe(packagedIntentDir);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
