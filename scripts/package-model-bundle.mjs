#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const cwd = process.cwd();
const args = parseArgs(process.argv.slice(2));
const version = args.version ?? timestampVersion();
const sourceRoot = path.resolve(cwd, args.source ?? '.data/models/models');
const bundlesRoot = path.resolve(cwd, args.outputRoot ?? '.data/model-bundles');
const bundleRoot = path.join(bundlesRoot, version);
const modelsRoot = path.join(bundleRoot, 'models');
const archivePath = path.join(bundlesRoot, `aso-model-runtime-bundle-${version}.tar.gz`);

const modelSpecs = {
  intent_classifier: [
    'config.json',
    'intent_id2label.json',
    'intent_label2id.json',
    'model.onnx',
    'tokenizer.json',
    'tokenizer_config.json',
    'train_meta.json',
  ],
  ner_extractor: [
    'config.json',
    'model.onnx',
    'ner_id2label.json',
    'ner_label2id.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'train_meta.json',
  ],
};

assertExists(sourceRoot, 'source model root');
fs.rmSync(bundleRoot, { recursive: true, force: true });
fs.mkdirSync(modelsRoot, { recursive: true });

const files = [];
for (const [modelName, filenames] of Object.entries(modelSpecs)) {
  const sourceDir = path.join(sourceRoot, modelName);
  const targetDir = path.join(modelsRoot, modelName);
  assertExists(sourceDir, `${modelName} source directory`);
  fs.mkdirSync(targetDir, { recursive: true });

  for (const filename of filenames) {
    const sourcePath = path.join(sourceDir, filename);
    const targetPath = path.join(targetDir, filename);
    assertExists(sourcePath, `${modelName}/${filename}`);
    fs.copyFileSync(sourcePath, targetPath);
    files.push(describeFile(bundleRoot, targetPath));
  }
}

const manifest = {
  schemaVersion: '1.0',
  bundleVersion: version,
  createdAt: new Date().toISOString(),
  sourceRoot,
  runtimeLayout: 'models/{intent_classifier,ner_extractor}',
  intentionallyExcluded: [
    'intent_classifier/model.onnx.data',
    'training checkpoints',
    'evaluation outputs',
  ],
  models: {
    intent_classifier: JSON.parse(
      fs.readFileSync(path.join(modelsRoot, 'intent_classifier', 'train_meta.json'), 'utf8'),
    ),
    ner_extractor: JSON.parse(
      fs.readFileSync(path.join(modelsRoot, 'ner_extractor', 'train_meta.json'), 'utf8'),
    ),
  },
  files,
};
fs.writeFileSync(path.join(bundleRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

fs.rmSync(archivePath, { force: true });
execFileSync('tar', ['-C', bundlesRoot, '-czf', archivePath, version], { stdio: 'inherit' });

const currentPath = path.join(bundlesRoot, 'current');
fs.rmSync(currentPath, { recursive: true, force: true });
fs.symlinkSync(version, currentPath);

console.log(`bundle:  ${bundleRoot}`);
console.log(`archive: ${archivePath}`);
console.log(`current: ${currentPath} -> ${version}`);
console.log(`size:    ${formatBytes(directorySize(bundleRoot))}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    const camelKey = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    parsed[camelKey] = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
  }
  return parsed;
}

function timestampVersion() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function assertExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Missing ${label}: ${targetPath}`);
  }
}

function describeFile(root, filePath) {
  const content = fs.readFileSync(filePath);
  return {
    path: path.relative(root, filePath),
    byteLength: content.byteLength,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

function directorySize(dirPath) {
  return fs.readdirSync(dirPath, { withFileTypes: true }).reduce((sum, entry) => {
    const entryPath = path.join(dirPath, entry.name);
    return sum + (entry.isDirectory() ? directorySize(entryPath) : fs.statSync(entryPath).size);
  }, 0);
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
