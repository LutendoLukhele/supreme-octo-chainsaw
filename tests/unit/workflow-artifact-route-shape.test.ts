import { ArtifactSpec } from '@aso/workflow-contracts';
import { DocumentArtifactPresenter } from '../../src/services/artifacts/DocumentArtifactPresenter';

describe('workflow artifact client shape', () => {
  it('uses artifactId plus a URL-first nested artifact without exposing renderedPath', () => {
    const spec: ArtifactSpec = {
      id: 'artifact_1',
      workflowId: 'wf_1',
      workflowStepId: 'step_1',
      kind: 'report',
      format: 'xlsx',
      title: 'Workflow Report',
      sections: [],
      bindings: {},
      status: 'ready',
      renderedPath: '/srv/app/.data/artifacts/artifact_1.xlsx',
      renderedFilename: 'artifact_1.xlsx',
      generationMode: 'server',
      previewRows: [['Deal', 'Value'], ['Acme', '1200']],
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
    };
    const presenter = new DocumentArtifactPresenter();

    const responseShape = {
      artifactId: spec.id,
      workflowId: spec.workflowId,
      workflowStepId: spec.workflowStepId,
      kind: spec.kind,
      format: spec.format,
      title: spec.title,
      sections: spec.sections,
      bindings: spec.bindings,
      status: spec.status,
      createdAt: spec.createdAt,
      updatedAt: spec.updatedAt,
      artifact: presenter.toClientArtifact(spec),
    };

    expect(responseShape).toMatchObject({
      artifactId: 'artifact_1',
      artifact: {
        filename: 'artifact_1.xlsx',
        format: 'xlsx',
        generationMode: 'server',
        previewRows: [['Deal', 'Value'], ['Acme', '1200']],
      },
    });
    expect(responseShape.artifact?.fileUrl).toContain('/api/artifacts/artifact_1/download');
    expect(responseShape).not.toHaveProperty('renderedPath');
  });
});
