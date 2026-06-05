#!/usr/bin/env node
/*
 * Workflow DOCX artifact smoke.
 *
 * Creates a workflow artifact through the WorkflowSpec/Compiler/ArtifactCompiler
 * path, then verifies the public workflow artifact shape and download URL
 * against a live ASO backend.
 *
 * Required:
 *   DATABASE_URL=postgres://...
 *
 * Optional:
 *   API_BASE_URL=http://localhost:8080
 */

const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const API_BASE_URL = (process.env.API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL?.trim().replace(/^(['"])(.*)\1$/, '$2');
const TEST_USER_ID = process.env.WORKFLOW_SMOKE_USER_ID || 'workflow-docx-smoke';

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

process.env.DATABASE_URL = DATABASE_URL;
process.env.PUBLIC_API_BASE_URL = API_BASE_URL;
process.env.DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || 'workflow-docx-smoke-unused';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const runtime = process.env.WORKFLOW_SMOKE_RUNTIME
  || (fs.existsSync(path.resolve(process.cwd(), 'src/services/workflow/WorkflowSpecFactory.ts')) ? 'src' : 'dist');
if (runtime === 'src') require('ts-node/register/transpile-only');
if (!['src', 'dist'].includes(runtime)) {
  console.error(`Invalid WORKFLOW_SMOKE_RUNTIME: ${runtime}`);
  process.exit(1);
}

const { neon } = require('@neondatabase/serverless');
const moduleRoot = path.resolve(process.cwd(), runtime);
const { WorkflowCatalogService } = require(path.join(moduleRoot, 'services/workflow/WorkflowCatalogService'));
const { WorkflowSpecFactory } = require(path.join(moduleRoot, 'services/workflow/WorkflowSpecFactory'));
const { WorkflowCompilerService } = require(path.join(moduleRoot, 'services/workflow/WorkflowCompilerService'));
const { WorkflowStore } = require(path.join(moduleRoot, 'services/workflow/WorkflowStore'));
const { ArtifactStore } = require(path.join(moduleRoot, 'services/workflow/ArtifactStore'));
const { ArtifactCompilerService } = require(path.join(moduleRoot, 'services/artifacts/ArtifactCompilerService'));
const { DocumentArtifactPresenter } = require(path.join(moduleRoot, 'services/artifacts/DocumentArtifactPresenter'));

function assert(condition, message, details) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function apiUrl(route) {
  return new URL(route, `${API_BASE_URL}/`).toString();
}

async function fetchOk(route) {
  const response = await fetch(apiUrl(route), {
    headers: { 'x-aso-test-user-id': TEST_USER_ID },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${route} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return { response, text };
}

async function main() {
  await fetchOk('/health/detailed');

  const sql = neon(DATABASE_URL);
  const artifactStore = new ArtifactStore(sql);
  const workflow = new WorkflowSpecFactory(new WorkflowCatalogService()).fromComposeRequest(
    {
      schemaVersion: '1.0',
      steps: [{
        id: 'step_1',
        whatPresetId: 'gmail_emails_with_attachments',
        whenPresetId: 'last_30_days',
        outputPresetId: 'word_summary',
      }],
    },
    { userId: TEST_USER_ID, sessionId: `workflow-docx-smoke-${Date.now()}` },
  );

  const { compiledPlan, artifactSpecs } = new WorkflowCompilerService().compile(workflow);
  assert(artifactSpecs.length === 1, 'expected exactly one artifact spec', artifactSpecs);

  await new WorkflowStore(sql).saveWorkflow(workflow, compiledPlan);
  await artifactStore.saveArtifacts(artifactSpecs);

  const sampleData = {
    records: [
      {
        subject: 'Invoice with attachment',
        from: 'billing@example.com',
        hasAttachments: true,
        summary: 'Monthly invoice attached for review.',
      },
      {
        subject: 'Contract packet',
        from: 'legal@example.com',
        hasAttachments: true,
        summary: 'Signed contract packet attached.',
      },
    ],
  };

  const rendered = await new ArtifactCompilerService(artifactStore).render(artifactSpecs[0], sampleData);
  const presenter = new DocumentArtifactPresenter();
  const directArtifact = presenter.toClientArtifact(rendered);

  assert(directArtifact, 'presenter did not return a client artifact', rendered);
  assert(directArtifact.format === 'docx', 'direct artifact format mismatch', directArtifact);
  assert(directArtifact.filename.endsWith('.docx'), 'direct artifact filename mismatch', directArtifact);
  assert(directArtifact.generationMode === 'server', 'direct artifact generationMode mismatch', directArtifact);
  assert(directArtifact.fileUrl && directArtifact.fileUrl.includes(`/api/artifacts/${rendered.id}/download`), 'direct artifact fileUrl mismatch', directArtifact);
  assert(!Object.prototype.hasOwnProperty.call(directArtifact, 'renderedPath'), 'direct artifact leaked renderedPath', directArtifact);
  assert(!Object.prototype.hasOwnProperty.call(directArtifact, 'filePath'), 'nested artifact leaked filePath', directArtifact);

  const artifactListResponse = await fetch(apiUrl(`/api/workflows/${workflow.id}/artifacts`), {
    headers: { 'x-aso-test-user-id': TEST_USER_ID },
  });
  const artifactListJson = await artifactListResponse.json();
  assert(artifactListResponse.ok, 'workflow artifact route failed', artifactListJson);
  const routeArtifactEnvelope = artifactListJson.artifacts?.[0];
  const routeArtifact = routeArtifactEnvelope?.artifact;

  assert(routeArtifactEnvelope?.artifactId === rendered.id, 'route artifactId mismatch', artifactListJson);
  assert(routeArtifact?.format === 'docx', 'route nested artifact format mismatch', routeArtifactEnvelope);
  assert(routeArtifact?.filename === path.basename(rendered.renderedPath), 'route nested filename mismatch', routeArtifactEnvelope);
  assert(routeArtifact?.generationMode === 'server', 'route generationMode mismatch', routeArtifactEnvelope);
  assert(routeArtifact?.fileUrl?.includes(`/api/artifacts/${rendered.id}/download`), 'route fileUrl mismatch', routeArtifactEnvelope);
  assert(!Object.prototype.hasOwnProperty.call(routeArtifactEnvelope, 'renderedPath'), 'route leaked renderedPath', routeArtifactEnvelope);
  assert(!Object.prototype.hasOwnProperty.call(routeArtifact, 'filePath'), 'route nested artifact leaked filePath', routeArtifact);

  const downloadUrl = new URL(routeArtifact.fileUrl);
  const downloadResponse = await fetch(apiUrl(downloadUrl.pathname), {
    headers: { 'x-aso-test-user-id': TEST_USER_ID },
  });
  const bytes = Buffer.from(await downloadResponse.arrayBuffer());

  assert(downloadResponse.ok, `download returned ${downloadResponse.status}`);
  assert(bytes.length > 0, 'download body was empty');
  assert(bytes[0] === 0x50 && bytes[1] === 0x4b, 'download body is not a DOCX/ZIP payload');
  assert(
    (downloadResponse.headers.get('content-disposition') || '').includes(routeArtifact.filename),
    'download content-disposition does not include filename',
    Object.fromEntries(downloadResponse.headers.entries()),
  );

  console.log(JSON.stringify({
    ok: true,
    runtime,
    apiBaseUrl: API_BASE_URL,
    workflowId: workflow.id,
    artifactId: rendered.id,
    filename: routeArtifact.filename,
    byteLength: bytes.length,
    fileUrl: routeArtifact.fileUrl,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
