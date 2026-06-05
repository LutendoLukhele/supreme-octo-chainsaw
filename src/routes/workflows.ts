import express, { Request, Response } from 'express';
import { NeonQueryFunction } from '@neondatabase/serverless';
import {
  WORKFLOW_CATALOG,
  WORKFLOW_CATALOG_COUNTS,
} from '@aso/workflow-contracts';
import { ArtifactStore } from '../services/workflow/ArtifactStore';
import { WorkflowStore } from '../services/workflow/WorkflowStore';
import { documentArtifactPresenter } from '../services/artifacts/DocumentArtifactPresenter';
import {
  AuthenticatedRequest,
  createRouteAuthMiddleware,
  RouteAuthOptions,
} from './auth';

export function createWorkflowsRouter(
  sql: NeonQueryFunction<false, false>,
  authOptions: RouteAuthOptions = {},
) {
  const router = express.Router();
  const artifactStore = new ArtifactStore(sql);
  const workflowStore = new WorkflowStore(sql);
  const requireAuth = createRouteAuthMiddleware(authOptions);

  router.get('/catalog', (_req: Request, res: Response) => {
    res.json({
      ...WORKFLOW_CATALOG,
      counts: WORKFLOW_CATALOG_COUNTS,
    });
  });

  router.get('/:workflowId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const workflow = await workflowStore.getWorkflowByIdForUser(req.params.workflowId, req.userId!);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    res.json(workflow);
  });

  router.get('/:workflowId/artifacts', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const workflow = await workflowStore.getWorkflowByIdForUser(req.params.workflowId, req.userId!);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const artifacts = await artifactStore.listArtifactsByWorkflowIdForUser(req.params.workflowId, req.userId!);
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
