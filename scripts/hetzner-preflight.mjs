#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const args = process.argv.slice(2);
const options = {
  envFile: undefined,
  modelRoot: undefined,
  nangoDist: undefined,
  artifactRoot: undefined,
  allowLocalDefaults: false,
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--env-file') options.envFile = args[++i];
  else if (arg === '--model-root') options.modelRoot = args[++i];
  else if (arg === '--nango-dist') options.nangoDist = args[++i];
  else if (arg === '--artifact-root') options.artifactRoot = args[++i];
  else if (arg === '--allow-local-defaults') options.allowLocalDefaults = true;
  else {
    console.error(`Unknown option: ${arg}`);
    process.exit(2);
  }
}

function loadEnvFile(file) {
  if (!file) return;
  const resolved = path.resolve(root, file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Env file not found: ${resolved}`);
  }
  const text = fs.readFileSync(resolved, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .replace(/\\n/g, '\n');
  }
}

function isDirectory(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function checkFile(checks, label, file) {
  let ok = false;
  let reason = 'is missing';
  try {
    const stat = fs.statSync(file);
    fs.accessSync(file, fs.constants.R_OK);
    ok = stat.isFile() && stat.size > 0;
    reason = stat.isFile() ? 'is empty' : 'is not a file';
  } catch {
    ok = false;
  }

  checks.push({
    label,
    path: file,
    ok,
    reason,
  });
}

function addFailure(failures, message, details = {}) {
  failures.push({ message, ...details });
}

function printablePath(file) {
  return path.isAbsolute(file) ? file : path.relative(root, file);
}

function requireEnv(failures, key, opts = {}) {
  const value = process.env[key]?.trim();
  if (!value) {
    addFailure(failures, `Missing required env var ${key}`);
    return;
  }
  if (opts.url) {
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:', 'redis:', 'postgres:', 'postgresql:'].includes(parsed.protocol)) {
        addFailure(failures, `Env var ${key} has unexpected protocol`, { value: redact(key, value) });
      }
    } catch {
      addFailure(failures, `Env var ${key} is not a valid URL`, { value: redact(key, value) });
    }
  }
  if (opts.publicHttps) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:') {
        addFailure(failures, `Env var ${key} must use HTTPS in strict production mode`, {
          value: redact(key, value),
        });
      }
      if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
        addFailure(failures, `Env var ${key} must not use a loopback host in strict production mode`, {
          value: redact(key, value),
        });
      }
    } catch {
      // The URL validation above reports the actionable failure.
    }
  }
}

function requireAnyEnv(failures, keys) {
  if (!keys.some((key) => process.env[key]?.trim())) {
    addFailure(failures, `Missing one of required env vars: ${keys.join(', ')}`);
  }
}

function checkCorsOrigins(failures) {
  const value = process.env.CORS_ORIGINS?.trim();
  if (!value || options.allowLocalDefaults) return;

  for (const origin of value.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    if (origin === '*') {
      addFailure(failures, 'CORS_ORIGINS must not contain a wildcard in strict production mode');
      continue;
    }
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:') {
        addFailure(failures, 'Every CORS_ORIGINS entry must use HTTPS in strict production mode', {
          value: origin,
        });
      }
      if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
        addFailure(failures, 'CORS_ORIGINS must not contain a loopback host in strict production mode', {
          value: origin,
        });
      }
      if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
        addFailure(failures, 'CORS_ORIGINS entries must be origins without paths, queries, or fragments', {
          value: origin,
        });
      }
    } catch {
      addFailure(failures, 'CORS_ORIGINS contains an invalid URL', { value: origin });
    }
  }
}

function redact(key, value) {
  if (!value) return value;
  if (/(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|DATABASE_URL|REDIS_URL)/.test(key)) {
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }
  return value;
}

function resolveModelRoot() {
  if (options.modelRoot) return path.resolve(root, options.modelRoot);
  if (process.env.ASO_MODEL_BUNDLE_PATH) return path.resolve(root, process.env.ASO_MODEL_BUNDLE_PATH);
  if (isDirectory('/app/models')) return '/app/models';
  return path.resolve(root, '.data', 'model-bundles', 'current', 'models');
}

function resolveNangoDist() {
  if (options.nangoDist) return path.resolve(root, options.nangoDist);
  if (process.env.NANGO_RUNTIME_DIST_DIR) return path.resolve(root, process.env.NANGO_RUNTIME_DIST_DIR);
  if (process.env.NANGO_INTEGRATIONS_DIST_DIR) return path.resolve(root, process.env.NANGO_INTEGRATIONS_DIST_DIR);
  if (isDirectory('/app/nango/nango-integrations/dist')) return '/app/nango/nango-integrations/dist';
  return path.resolve(root, 'nango-integrations-backup', 'dist');
}

function resolveArtifactRoot() {
  if (options.artifactRoot) return path.resolve(root, options.artifactRoot);
  if (process.env.ASO_ARTIFACTS_PATH) return path.resolve(root, process.env.ASO_ARTIFACTS_PATH);
  if (isDirectory('/app/.data/artifacts')) return '/app/.data/artifacts';
  return path.resolve(root, '.data', 'artifacts');
}

function checkArtifactRoot(failures) {
  const artifactRoot = resolveArtifactRoot();
  if (!isDirectory(artifactRoot)) {
    addFailure(failures, 'Artifact storage root is missing or not a directory', { path: artifactRoot });
    return { artifactRoot };
  }
  try {
    fs.accessSync(artifactRoot, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    addFailure(failures, 'Artifact storage root is not readable and writable', { path: artifactRoot });
    return { artifactRoot };
  }

  const probe = path.join(
    artifactRoot,
    `.aso-preflight-write-${process.pid}-${Date.now()}`,
  );
  try {
    fs.writeFileSync(probe, 'aso-preflight');
    fs.unlinkSync(probe);
  } catch {
    try {
      if (fs.existsSync(probe)) fs.unlinkSync(probe);
    } catch {
      // Preserve the original write-probe failure.
    }
    addFailure(failures, 'Artifact storage root failed a write/delete probe', { path: artifactRoot });
  }
  return { artifactRoot };
}

function checkModelBundle(failures, checks) {
  const modelRoot = resolveModelRoot();
  if (!isDirectory(modelRoot)) {
    addFailure(failures, 'ONNX model bundle root is missing or not a directory', { path: modelRoot });
    return { modelRoot };
  }

  const intentDir = !options.modelRoot && process.env.ML_INTENT_MODEL_DIR
    ? path.resolve(root, process.env.ML_INTENT_MODEL_DIR)
    : path.join(modelRoot, 'intent_classifier');
  const nerDir = !options.modelRoot && process.env.ML_NER_MODEL_DIR
    ? path.resolve(root, process.env.ML_NER_MODEL_DIR)
    : path.join(modelRoot, 'ner_extractor');
  const intentFiles = ['model.onnx', 'tokenizer.json', 'config.json', 'intent_id2label.json', 'intent_label2id.json'];
  const nerFiles = ['model.onnx', 'tokenizer.json', 'config.json', 'ner_id2label.json', 'ner_label2id.json'];

  for (const file of intentFiles) checkFile(checks, `intent_classifier/${file}`, path.join(intentDir, file));
  for (const file of nerFiles) checkFile(checks, `ner_extractor/${file}`, path.join(nerDir, file));

  return { modelRoot };
}

function checkNangoRuntime(failures, checks) {
  const nangoDist = resolveNangoDist();
  if (!isDirectory(nangoDist)) {
    addFailure(failures, 'Nango compiled runtime dist is missing or not a directory', { path: nangoDist });
    return { nangoDist };
  }

  const requiredFiles = [
    'fetch-emails-google-mail-ynxw.js',
    'fetch-attachment-google-mail-ynxw.js',
    'send-email-google-mail-ynxw.js',
    'emails-google-mail-ynxw.js',
    'calendar-fetch-events-google-calendar.js',
    'calendar-create-event-google-calendar.js',
    'calendar-update-event-google-calendar.js',
    'events-google-calendar.js',
    'salesforce-fetch-entity-salesforce-ybzg.js',
    'salesforce-create-entity-salesforce-ybzg.js',
    'salesforce-update-entity-salesforce-ybzg.js',
    'entities-salesforce-ybzg.js',
  ];

  for (const file of requiredFiles) {
    checkFile(checks, `nango/dist/${file}`, path.join(nangoDist, file));
  }

  return { nangoDist };
}

function checkEnv(failures) {
  const strictPublicUrls = !options.allowLocalDefaults;
  const required = [
    ['DATABASE_URL', { url: true }],
    ['PUBLIC_API_BASE_URL', { url: true, publicHttps: strictPublicUrls }],
    ['NANGO_BASE_URL', { url: true }],
    ['NANGO_PUBLIC_BASE_URL', { url: true, publicHttps: strictPublicUrls }],
    ['NANGO_SECRET_KEY', {}],
    ['NANGO_WEBHOOK_SECRET', {}],
    ['CORS_ORIGINS', {}],
    ['OPEN_AI_API_KEY', {}],
    ['GROQ_API_KEY', {}],
    ['FIREBASE_PROJECT_ID', {}],
    ['FIREBASE_PRIVATE_KEY', {}],
    ['FIREBASE_CLIENT_EMAIL', {}],
  ];

  for (const [key, opts] of required) requireEnv(failures, key, opts);
  requireAnyEnv(failures, ['REDIS_URL', 'REDIS_PASSWORD']);
  checkCorsOrigins(failures);

  const hasIntentModelDir = Boolean(process.env.ML_INTENT_MODEL_DIR?.trim());
  const hasNerModelDir = Boolean(process.env.ML_NER_MODEL_DIR?.trim());
  if (hasIntentModelDir !== hasNerModelDir) {
    addFailure(failures, 'ML_INTENT_MODEL_DIR and ML_NER_MODEL_DIR must be configured together');
  }

  if (
    !options.allowLocalDefaults &&
    !options.modelRoot &&
    !hasIntentModelDir &&
    !hasNerModelDir &&
    !isDirectory('/app/models')
  ) {
    requireEnv(failures, 'ASO_MODEL_BUNDLE_PATH');
  }

  if (
    !options.allowLocalDefaults &&
    !options.nangoDist &&
    !process.env.NANGO_RUNTIME_DIST_DIR &&
    !process.env.NANGO_INTEGRATIONS_DIST_DIR &&
    !isDirectory('/app/nango/nango-integrations/dist')
  ) {
    addFailure(failures, 'Missing NANGO_RUNTIME_DIST_DIR or NANGO_INTEGRATIONS_DIST_DIR for the production Nango mount');
  }

  if (
    !options.allowLocalDefaults &&
    !options.artifactRoot &&
    !process.env.ASO_ARTIFACTS_PATH &&
    !isDirectory('/app/.data/artifacts')
  ) {
    addFailure(failures, 'Missing ASO_ARTIFACTS_PATH for persistent document artifact storage');
  }
}

try {
  loadEnvFile(options.envFile);

  const failures = [];
  const checks = [];

  checkEnv(failures);
  const { modelRoot } = checkModelBundle(failures, checks);
  const { nangoDist } = checkNangoRuntime(failures, checks);
  const { artifactRoot } = checkArtifactRoot(failures);

  for (const check of checks) {
    if (!check.ok) addFailure(failures, `${check.label} ${check.reason}`, { path: check.path });
  }

  const summary = {
    ok: failures.length === 0,
    modelRoot,
    nangoDist,
    artifactRoot,
    checkedFiles: checks.length,
    failures,
  };

  if (summary.ok) {
    console.log(JSON.stringify({
      ok: true,
      modelRoot: printablePath(modelRoot),
      nangoDist: printablePath(nangoDist),
      artifactRoot: printablePath(artifactRoot),
      checkedFiles: checks.length,
    }, null, 2));
  } else {
    console.error('Hetzner preflight failed:');
    for (const failure of failures) {
      const suffix = failure.path ? ` (${printablePath(failure.path)})` : '';
      console.error(`- ${failure.message}${suffix}`);
    }
    console.error(JSON.stringify(summary, null, 2));
    process.exit(1);
  }
} catch (error) {
  console.error(error.stack || error.message || error);
  process.exit(1);
}
