import { ArtifactSpec } from '@aso/workflow-contracts';
import { DocumentArtifactPresenter } from '../../src/services/artifacts/DocumentArtifactPresenter';

describe('DocumentArtifactPresenter', () => {
  it('builds a URL-first client artifact and omits the server filesystem path', () => {
    const presenter = new DocumentArtifactPresenter();
    const spec: ArtifactSpec = {
      id: 'artifact_1',
      workflowId: 'wf_1',
      workflowStepId: 'step_1',
      kind: 'summary_document',
      format: 'docx',
      title: 'Word Summary',
      sections: [],
      bindings: {},
      status: 'ready',
      renderedPath: '/tmp/server-only.docx',
      renderedFilename: 'word-summary.docx',
      generationMode: 'server',
      previewText: 'Word Summary',
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
    };

    const artifact = presenter.toClientArtifact(spec);
    expect(artifact).toMatchObject({
      filename: 'word-summary.docx',
      format: 'docx',
      generationMode: 'server',
      previewText: 'Word Summary',
    });
    expect(artifact?.fileUrl).toContain('/api/artifacts/artifact_1/download');
    expect(artifact).not.toHaveProperty('filePath');
  });

  it('does not expose a download payload before the file is ready', () => {
    const presenter = new DocumentArtifactPresenter();
    const spec: ArtifactSpec = {
      id: 'artifact_2',
      workflowId: 'wf_1',
      workflowStepId: 'step_1',
      kind: 'report',
      format: 'xlsx',
      title: 'Workflow Report',
      sections: [],
      bindings: {},
      status: 'rendering',
      renderedPath: '/tmp/not-ready-yet.xlsx',
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
    };

    expect(presenter.toClientArtifact(spec)).toBeUndefined();
  });

  it('normalizes a quoted public API URL from a direct Docker env file', () => {
    const previous = process.env.PUBLIC_API_BASE_URL;
    process.env.PUBLIC_API_BASE_URL = '"https://api.example.com/"';

    try {
      const presenter = new DocumentArtifactPresenter();
      expect(presenter.downloadUrl('artifact_3')).toBe(
        'https://api.example.com/api/artifacts/artifact_3/download',
      );
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_API_BASE_URL;
      else process.env.PUBLIC_API_BASE_URL = previous;
    }
  });
});
