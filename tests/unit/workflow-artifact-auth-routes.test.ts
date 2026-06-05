import express from 'express';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { Duplex } from 'stream';
import { WorkflowSpec } from '@aso/workflow-contracts';

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-groq-api-key';

const { createArtifactsRouter } = require('../../src/routes/artifacts') as typeof import('../../src/routes/artifacts');
const { createWorkflowsRouter } = require('../../src/routes/workflows') as typeof import('../../src/routes/workflows');

const now = '2026-06-05T00:00:00.000Z';
const ownerUserId = 'owner-user';
const otherUserId = 'other-user';
const workflowId = 'wf_auth_owner';
const artifactId = 'artifact_auth_owner';

class MockSocket extends Duplex {
  _read() {}

  _write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    callback();
  }
}

interface InjectResponse {
  status: number;
  headers: http.OutgoingHttpHeaders;
  body: Buffer;
  json: () => any;
}

function workflowSpec(): WorkflowSpec {
  return {
    schemaVersion: '1.0',
    id: workflowId,
    source: 'ui_slot',
    displayText: 'Find Gmail attachments today and generate a Word summary',
    steps: [],
    dependencies: [],
    metadata: {
      userId: ownerUserId,
      createdAt: now,
    },
  };
}

function artifactRow(renderedPath: string) {
  return {
    id: artifactId,
    workflow_id: workflowId,
    workflow_step_id: 'step_1',
    kind: 'summary_document',
    format: 'docx',
    title: 'Word Summary',
    sections_json: [],
    bindings_json: {},
    status: 'ready',
    rendered_path: renderedPath,
    rendered_filename: `${artifactId}.docx`,
    byte_length: 4,
    generation_mode: 'server',
    preview_rows_json: null,
    preview_text: 'Word Summary',
    created_at: now,
    updated_at: now,
  };
}

function createFakeSql(renderedPath: string) {
  const workflowRow = {
    id: workflowId,
    user_id: ownerUserId,
    session_id: 'session_1',
    source: 'ui_slot',
    display_text: 'Find Gmail attachments today and generate a Word summary',
    spec_json: workflowSpec(),
    compiled_plan_json: { workflowId, nodes: [], edges: [] },
    created_at: now,
    updated_at: now,
  };
  const artifact = artifactRow(renderedPath);

  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    if (query.includes('FROM workflow_specs')) {
      const [requestedWorkflowId, requestedUserId] = values;
      return requestedWorkflowId === workflowId && requestedUserId === ownerUserId
        ? Promise.resolve([workflowRow])
        : Promise.resolve([]);
    }

    if (query.includes('FROM workflow_artifacts a') && query.includes('WHERE a.id =')) {
      const [requestedArtifactId, requestedUserId] = values;
      return requestedArtifactId === artifactId && requestedUserId === ownerUserId
        ? Promise.resolve([artifact])
        : Promise.resolve([]);
    }

    if (query.includes('FROM workflow_artifacts a') && query.includes('WHERE a.workflow_id =')) {
      const [requestedWorkflowId, requestedUserId] = values;
      return requestedWorkflowId === workflowId && requestedUserId === ownerUserId
        ? Promise.resolve([artifact])
        : Promise.resolve([]);
    }

    return Promise.resolve([]);
  }) as any;
}

async function inject(
  app: express.Express,
  route: string,
  auth?: string | http.IncomingHttpHeaders,
): Promise<InjectResponse> {
  return new Promise((resolve, reject) => {
    const socket = new MockSocket() as any;
    const req = new http.IncomingMessage(socket);
    req.method = 'GET';
    req.url = route;
    req.headers = typeof auth === 'string' ? { 'x-aso-test-user-id': auth } : auth ?? {};

    const res = new http.ServerResponse(req);
    res.assignSocket(socket);

    const chunks: Buffer[] = [];
    res.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error) => void), callback?: (error?: Error) => void) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
      }
      if (typeof encoding === 'function') encoding();
      if (callback) callback();
      return true;
    }) as typeof res.write;

    res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
      }
      if (typeof encoding === 'function') encoding();
      if (callback) callback();
      const body = Buffer.concat(chunks);
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        body,
        json: () => JSON.parse(body.toString('utf8')),
      });
      return res;
    }) as typeof res.end;

    (app as any).handle(req, res, reject);
  });
}

async function withApp<T>(
  handler: (app: express.Express) => Promise<T>,
  authOptions: Parameters<typeof createWorkflowsRouter>[1] = { allowTestUserHeader: true },
): Promise<T> {
  const outputDir = path.join(process.cwd(), '.data', 'artifacts');
  await fs.mkdir(outputDir, { recursive: true });
  const renderedPath = path.join(outputDir, `${artifactId}.docx`);
  await fs.writeFile(renderedPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  const app = express();
  const sql = createFakeSql(renderedPath);
  app.use('/api/workflows', createWorkflowsRouter(sql, authOptions));
  app.use('/api/artifacts', createArtifactsRouter(sql, authOptions));

  try {
    return await handler(app);
  } finally {
    await fs.unlink(renderedPath).catch(() => undefined);
  }
}

describe('workflow and artifact route authorization', () => {
  it('requires authentication before returning workflow artifacts or downloads', async () => {
    await withApp(async (app) => {
      const artifactsResponse = await inject(app, `/api/workflows/${workflowId}/artifacts`);
      const downloadResponse = await inject(app, `/api/artifacts/${artifactId}/download`);

      expect(artifactsResponse.status).toBe(401);
      expect(downloadResponse.status).toBe(401);
    });
  });

  it('allows the owner to list and download a ready workflow document artifact', async () => {
    await withApp(async (app) => {
      const workflowResponse = await inject(app, `/api/workflows/${workflowId}`, ownerUserId);
      const workflowJson = workflowResponse.json();
      const artifactsResponse = await inject(app, `/api/workflows/${workflowId}/artifacts`, ownerUserId);
      const artifactsJson = artifactsResponse.json();

      expect(workflowResponse.status).toBe(200);
      expect(workflowJson).toMatchObject({
        id: workflowId,
        user_id: ownerUserId,
        display_text: 'Find Gmail attachments today and generate a Word summary',
      });
      expect(workflowJson).toHaveProperty('spec_json');
      expect(workflowJson).toHaveProperty('compiled_plan_json');
      expect(artifactsResponse.status).toBe(200);
      expect(artifactsJson.artifacts[0]).toMatchObject({
        artifactId,
        workflowId,
        artifact: {
          filename: `${artifactId}.docx`,
          format: 'docx',
          generationMode: 'server',
        },
      });
      expect(artifactsJson.artifacts[0]).not.toHaveProperty('renderedPath');
      expect(artifactsJson.artifacts[0].artifact).not.toHaveProperty('filePath');

      const downloadResponse = await inject(app, `/api/artifacts/${artifactId}/download`, ownerUserId);
      const bytes = downloadResponse.body;

      expect(downloadResponse.status).toBe(200);
      expect(bytes[0]).toBe(0x50);
      expect(bytes[1]).toBe(0x4b);
    });
  });

  it('accepts a verified bearer token as the workflow owner identity', async () => {
    await withApp(
      async (app) => {
        const artifactsResponse = await inject(app, `/api/workflows/${workflowId}/artifacts`, {
          authorization: 'Bearer owner-token',
        });
        const artifactsJson = artifactsResponse.json();

        expect(artifactsResponse.status).toBe(200);
        expect(artifactsJson.artifacts[0]).toMatchObject({
          artifactId,
          workflowId,
        });
      },
      {
        allowTestUserHeader: false,
        verifyIdToken: async (idToken) => {
          if (idToken !== 'owner-token') throw new Error('invalid token');
          return { uid: ownerUserId };
        },
      },
    );
  });

  it('does not expose another user workflow or document artifact', async () => {
    await withApp(async (app) => {
      const workflowResponse = await inject(app, `/api/workflows/${workflowId}`, otherUserId);
      const artifactsResponse = await inject(app, `/api/workflows/${workflowId}/artifacts`, otherUserId);
      const downloadResponse = await inject(app, `/api/artifacts/${artifactId}/download`, otherUserId);

      expect(workflowResponse.status).toBe(404);
      expect(artifactsResponse.status).toBe(404);
      expect(downloadResponse.status).toBe(404);
    });
  });
});
