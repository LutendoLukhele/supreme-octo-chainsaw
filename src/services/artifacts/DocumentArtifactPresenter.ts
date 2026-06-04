import path from 'path';
import {
  ArtifactSpec,
  GeneratedDocumentArtifact,
} from '@aso/workflow-contracts';

function normalizedEnvValue(value: string | undefined): string | undefined {
  return value
    ?.trim()
    .replace(/^(['"])(.*)\1$/, '$2');
}

export class DocumentArtifactPresenter {
  constructor(
    private readonly publicApiBaseUrl = (
      normalizedEnvValue(process.env.PUBLIC_API_BASE_URL)
      || `http://localhost:${normalizedEnvValue(process.env.PORT) || '8080'}`
    ).replace(/\/+$/, ''),
  ) {}

  toClientArtifact(spec: ArtifactSpec): GeneratedDocumentArtifact | undefined {
    if (spec.status !== 'ready' || spec.format === 'internal' || !spec.renderedPath) {
      return undefined;
    }

    return {
      filename: spec.renderedFilename ?? path.basename(spec.renderedPath),
      format: spec.format,
      fileUrl: this.downloadUrl(spec.id),
      generationMode: spec.generationMode ?? 'server',
      previewRows: spec.previewRows,
      previewText: spec.previewText,
    };
  }

  downloadUrl(artifactId: string): string {
    return `${this.publicApiBaseUrl}/api/artifacts/${encodeURIComponent(artifactId)}/download`;
  }
}

export const documentArtifactPresenter = new DocumentArtifactPresenter();
