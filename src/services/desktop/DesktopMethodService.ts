import { ArtifactSpec, GeneratedDocumentArtifact } from '@aso/workflow-contracts';
import { ArtifactCompilerService } from '../artifacts/ArtifactCompilerService';
import {
  DocumentArtifactPresenter,
  documentArtifactPresenter,
} from '../artifacts/DocumentArtifactPresenter';

export class DesktopMethodService {
  constructor(
    private readonly artifactCompilerService: ArtifactCompilerService,
    private readonly presenter: DocumentArtifactPresenter = documentArtifactPresenter,
  ) {}

  async generateFile(input: {
    artifactSpec: ArtifactSpec;
    data: unknown;
  }): Promise<{ filePath: string; artifactId: string; artifact: GeneratedDocumentArtifact }> {
    const rendered = await this.artifactCompilerService.render(input.artifactSpec, input.data);
    if (rendered.format === 'internal') {
      throw new Error('generateFile cannot materialize internal-only artifacts');
    }
    const artifact = this.presenter.toClientArtifact(rendered);
    if (!artifact) {
      throw new Error(`Failed to build client artifact payload for ${rendered.id}`);
    }

    return {
      filePath: rendered.renderedPath!,
      artifactId: rendered.id,
      artifact,
    };
  }
}
