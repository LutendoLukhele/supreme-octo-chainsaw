import { ArtifactSpec } from '@aso/workflow-contracts';
import { ArtifactRenderResult, ArtifactRendererRegistry } from './ArtifactRenderer';
import { ArtifactStore } from '../workflow/ArtifactStore';

export class ArtifactCompilerService {
  constructor(
    private readonly store: ArtifactStore,
    private readonly registry = new ArtifactRendererRegistry(),
  ) {}

  async render(spec: ArtifactSpec, data: unknown): Promise<ArtifactSpec & { renderResult: ArtifactRenderResult }> {
    await this.store.updateArtifactStatus(spec.id, 'rendering');
    try {
      const renderer = this.registry.getRenderer(spec);
      const result = await renderer.render(spec, data);
      const ready = {
        ...spec,
        status: 'ready' as const,
        renderedPath: result.path,
        renderedFilename: result.filename,
        byteLength: result.byteLength,
        generationMode: 'server' as const,
        previewRows: result.previewRows,
        previewText: result.previewText,
        updatedAt: new Date().toISOString(),
        renderResult: result,
      };
      await this.store.saveArtifacts([ready]);
      return ready;
    } catch (error) {
      await this.store.updateArtifactStatus(spec.id, 'error');
      throw error;
    }
  }
}
