import { ArtifactSpec } from '@aso/workflow-contracts';
import { ArtifactCompilerService } from '../../src/services/artifacts/ArtifactCompilerService';

describe('ArtifactCompilerService', () => {
  it('upserts ready artifact delivery metadata after rendering', async () => {
    const now = '2026-06-03T00:00:00.000Z';
    const spec: ArtifactSpec = {
      id: 'artifact_delivery_test',
      workflowId: 'wf_1',
      workflowStepId: 'step_1',
      kind: 'report',
      format: 'xlsx',
      title: 'Workflow Report',
      sections: [],
      bindings: {},
      status: 'compiled',
      createdAt: now,
      updatedAt: now,
    };
    const store: any = {
      updateArtifactStatus: jest.fn(async () => undefined),
      saveArtifacts: jest.fn(async () => undefined),
    };
    const registry: any = {
      getRenderer: jest.fn(() => ({
        render: jest.fn(async () => ({
          path: '/tmp/artifact_delivery_test.xlsx',
          byteLength: 123,
          filename: 'artifact_delivery_test.xlsx',
          previewRows: [['Deal'], ['Acme']],
        })),
      })),
    };

    const service = new ArtifactCompilerService(store, registry);
    const ready = await service.render(spec, [{ Deal: 'Acme' }]);

    expect(store.updateArtifactStatus).toHaveBeenCalledWith(spec.id, 'rendering');
    expect(store.saveArtifacts).toHaveBeenCalledWith([
      expect.objectContaining({
        id: spec.id,
        status: 'ready',
        renderedPath: '/tmp/artifact_delivery_test.xlsx',
        renderedFilename: 'artifact_delivery_test.xlsx',
        byteLength: 123,
        generationMode: 'server',
        previewRows: [['Deal'], ['Acme']],
      }),
    ]);
    expect(ready.renderedPath).toBe('/tmp/artifact_delivery_test.xlsx');
  });
});
