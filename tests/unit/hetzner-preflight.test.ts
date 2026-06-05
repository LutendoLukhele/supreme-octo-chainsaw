import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const intentFiles = [
  'model.onnx',
  'tokenizer.json',
  'config.json',
  'intent_id2label.json',
  'intent_label2id.json',
];

const nerFiles = [
  'model.onnx',
  'tokenizer.json',
  'config.json',
  'ner_id2label.json',
  'ner_label2id.json',
];

const nangoFiles = [
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

function createFixture(): { root: string; modelRoot: string; nangoDist: string; artifactRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aso-hetzner-preflight-'));
  const modelRoot = path.join(root, 'models');
  const intentDir = path.join(modelRoot, 'intent_classifier');
  const nerDir = path.join(modelRoot, 'ner_extractor');
  const nangoDist = path.join(root, 'nango-dist');
  const artifactRoot = path.join(root, 'artifacts');

  fs.mkdirSync(intentDir, { recursive: true });
  fs.mkdirSync(nerDir, { recursive: true });
  fs.mkdirSync(nangoDist, { recursive: true });
  fs.mkdirSync(artifactRoot, { recursive: true });

  for (const file of intentFiles) fs.writeFileSync(path.join(intentDir, file), 'intent');
  for (const file of nerFiles) fs.writeFileSync(path.join(nerDir, file), 'ner');
  for (const file of nangoFiles) fs.writeFileSync(path.join(nangoDist, file), 'runtime');

  return { root, modelRoot, nangoDist, artifactRoot };
}

function runPreflight(
  modelRoot: string,
  nangoDist: string,
  artifactRoot: string,
  options: {
    env?: NodeJS.ProcessEnv;
    allowLocalDefaults?: boolean;
  } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: 'postgresql://user:password@database.example.com/aso',
    REDIS_URL: 'redis://redis.example.com:6379',
    PUBLIC_API_BASE_URL: 'https://api.example.com',
    NANGO_BASE_URL: 'https://nango.internal.example.com',
    NANGO_PUBLIC_BASE_URL: 'https://nango.example.com',
    NANGO_SECRET_KEY: 'nango-secret',
    NANGO_WEBHOOK_SECRET: 'nango-webhook-secret',
    CORS_ORIGINS: 'https://app.example.com',
    OPEN_AI_API_KEY: 'openai-api-key',
    GROQ_API_KEY: 'groq-api-key',
    FIREBASE_PROJECT_ID: 'aso-test',
    FIREBASE_PRIVATE_KEY: 'firebase-private-key',
    FIREBASE_CLIENT_EMAIL: 'firebase@example.com',
    ...options.env,
  };
  if (!options.env?.ASO_MODEL_BUNDLE_PATH) delete env.ASO_MODEL_BUNDLE_PATH;
  if (!options.env?.ML_INTENT_MODEL_DIR) delete env.ML_INTENT_MODEL_DIR;
  if (!options.env?.ML_NER_MODEL_DIR) delete env.ML_NER_MODEL_DIR;
  if (!options.env?.NANGO_RUNTIME_DIST_DIR) delete env.NANGO_RUNTIME_DIST_DIR;
  if (!options.env?.NANGO_INTEGRATIONS_DIST_DIR) delete env.NANGO_INTEGRATIONS_DIST_DIR;

  const args = [
    path.join(process.cwd(), 'scripts', 'hetzner-preflight.mjs'),
    '--model-root',
    modelRoot,
    '--nango-dist',
    nangoDist,
    '--artifact-root',
    artifactRoot,
  ];
  if (options.allowLocalDefaults) args.push('--allow-local-defaults');

  return spawnSync(
    process.execPath,
    args,
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    },
  );
}

describe('Hetzner deploy preflight', () => {
  it('passes when production env, model files, and Nango runtime files are complete', () => {
    const fixture = createFixture();
    try {
      const result = runPreflight(fixture.modelRoot, fixture.nangoDist, fixture.artifactRoot);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        checkedFiles: intentFiles.length + nerFiles.length + nangoFiles.length,
      });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fails when a required compiled Gmail runtime file is missing', () => {
    const fixture = createFixture();
    try {
      fs.rmSync(path.join(fixture.nangoDist, 'fetch-emails-google-mail-ynxw.js'));
      const result = runPreflight(fixture.modelRoot, fixture.nangoDist, fixture.artifactRoot);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('fetch-emails-google-mail-ynxw.js is missing');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects loopback HTTP public URLs in strict production mode', () => {
    const fixture = createFixture();
    try {
      const result = runPreflight(fixture.modelRoot, fixture.nangoDist, fixture.artifactRoot, {
        env: {
          PUBLIC_API_BASE_URL: 'http://localhost:8080',
          NANGO_PUBLIC_BASE_URL: 'http://127.0.0.1:3003',
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('PUBLIC_API_BASE_URL must use HTTPS');
      expect(result.stderr).toContain('PUBLIC_API_BASE_URL must not use a loopback host');
      expect(result.stderr).toContain('NANGO_PUBLIC_BASE_URL must use HTTPS');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('allows loopback HTTP public URLs only with explicit local defaults', () => {
    const fixture = createFixture();
    try {
      const result = runPreflight(fixture.modelRoot, fixture.nangoDist, fixture.artifactRoot, {
        allowLocalDefaults: true,
        env: {
          PUBLIC_API_BASE_URL: 'http://localhost:8080',
          NANGO_PUBLIC_BASE_URL: 'http://127.0.0.1:3003',
        },
      });

      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects the local test auth header escape hatch in strict production mode', () => {
    const fixture = createFixture();
    try {
      const result = runPreflight(fixture.modelRoot, fixture.nangoDist, fixture.artifactRoot, {
        env: {
          ASO_ALLOW_TEST_AUTH_HEADER: '1',
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ASO_ALLOW_TEST_AUTH_HEADER must be disabled in strict production mode');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe or non-origin CORS entries in strict production mode', () => {
    const fixture = createFixture();
    try {
      const result = runPreflight(fixture.modelRoot, fixture.nangoDist, fixture.artifactRoot, {
        env: {
          CORS_ORIGINS: '*,http://localhost:54059/app,https://app.example.com/app',
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('CORS_ORIGINS must not contain a wildcard');
      expect(result.stderr).toContain('Every CORS_ORIGINS entry must use HTTPS');
      expect(result.stderr).toContain('CORS_ORIGINS must not contain a loopback host');
      expect(result.stderr).toContain('CORS_ORIGINS entries must be origins without paths');
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('uses an explicit model root instead of container-only ML model paths', () => {
    const fixture = createFixture();
    try {
      const result = runPreflight(fixture.modelRoot, fixture.nangoDist, fixture.artifactRoot, {
        env: {
          ML_INTENT_MODEL_DIR: '/app/models/intent_classifier',
          ML_NER_MODEL_DIR: '/app/models/ner_extractor',
        },
      });

      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
