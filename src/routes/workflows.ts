import express, { Request, Response } from 'express';
import { NeonQueryFunction } from '@neondatabase/serverless';
import {
  WORKFLOW_CATALOG,
  WORKFLOW_CATALOG_COUNTS,
} from '@aso/workflow-contracts';
import { ArtifactStore } from '../services/workflow/ArtifactStore';
import { documentArtifactPresenter } from '../services/artifacts/DocumentArtifactPresenter';

export function createWorkflowsRouter(sql: NeonQueryFunction<false, false>) {
  const router = express.Router();
  const artifactStore = new ArtifactStore(sql);

  router.get('/catalog', (_req: Request, res: Response) => {
    res.json({
      ...WORKFLOW_CATALOG,
      counts: WORKFLOW_CATALOG_COUNTS,
    });
  });

  router.get('/:workflowId', async (req: Request, res: Response) => {
    const rows = await sql`
      SELECT id, user_id, session_id, source, display_text, spec_json, compiled_plan_json,
             created_at, updated_at
      FROM workflow_specs
      WHERE id = ${req.params.workflowId}
      LIMIT 1
    `;
    if (!rows[0]) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    res.json(rows[0]);
  });

  router.get('/:workflowId/artifacts', async (req: Request, res: Response) => {
    const artifacts = await artifactStore.listArtifactsByWorkflowId(req.params.workflowId);
    res.json({
      artifacts: artifacts.map((artifact) => ({
        artifactId: artifact.id,
        workflowId: artifact.workflowId,
        workflowStepId: artifact.workflowStepId,
        kind: artifact.kind,
        format: artifact.format,
        title: artifact.title,
        sections: artifact.sections,
        bindings: artifact.bindings,
        status: artifact.status,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
        artifact: documentArtifactPresenter.toClientArtifact(artifact),
      })),
    });
  });

  return router;
}
