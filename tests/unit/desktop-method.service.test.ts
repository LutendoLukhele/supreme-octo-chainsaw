import { ArtifactSpec } from '@aso/workflow-contracts';
import { DesktopMethodService } from '../../src/services/desktop/DesktopMethodService';

describe('DesktopMethodService', () => {
  it('returns the canonical document artifact envelope while preserving legacy fields', async () => {
    const now = new Date().toISOString();
    const spec: ArtifactSpec = {
      id: 'artifact_docx_contract',
      workflowId: 'wf_1',
      workflowStepId: 'step_1',
      kind: 'summary_document',
      format: 'docx',
      title: 'Word Summary',
      sections: [],
      bindings: {},
      status: 'compiled',
      createdAt: now,
      updatedAt: now,
    };
    const artifactCompilerService: any = {
      render: jest.fn(async () => ({
        ...spec,
        status: 'ready',
        renderedPath: '/tmp/artifact_docx_contract.docx',
        renderResult: {
          path: '/tmp/artifact_docx_contract.docx',
          byteLength: 123,
          filename: 'artifact_docx_contract.docx',
          previewText: 'Word Summary',
        },
      })),
    };
    const presenter: any = {
      toClientArtifact: jest.fn(() => ({
        filename: 'artifact_docx_contract.docx',
        format: 'docx',
        fileUrl: 'https://api.example.com/api/artifacts/artifact_docx_contract/download',
        generationMode: 'server',
        previewText: 'Word Summary',
      })),
    };
    const service = new DesktopMethodService(artifactCompilerService, presenter);

    await expect(service.generateFile({ artifactSpec: spec, data: [{ name: 'Acme' }] })).resolves.toEqual({
      filePath: '/tmp/artifact_docx_contract.docx',
      artifactId: 'artifact_docx_contract',
      artifact: {
        filename: 'artifact_docx_contract.docx',
        format: 'docx',
        fileUrl: 'https://api.example.com/api/artifacts/artifact_docx_contract/download',
        generationMode: 'server',
        previewText: 'Word Summary',
      },
    });
  });
});
