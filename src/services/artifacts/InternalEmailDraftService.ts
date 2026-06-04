import fs from 'fs/promises';
import path from 'path';
import { ArtifactStore } from '../workflow/ArtifactStore';
import { ArtifactSpec } from '@aso/workflow-contracts';

export class InternalEmailDraftService {
  constructor(private readonly store: ArtifactStore) {}

  async create(spec: ArtifactSpec, data: unknown): Promise<{ artifactId: string; renderedPath: string }> {
    const outputDir = path.join(process.cwd(), '.data', 'artifacts');
    await fs.mkdir(outputDir, { recursive: true });
    const renderedPath = path.join(outputDir, `${spec.id}.json`);
    const payload = {
      artifactId: spec.id,
      kind: spec.kind,
      generatedAt: new Date().toISOString(),
      sourceData: data,
    };
    await fs.writeFile(renderedPath, JSON.stringify(payload, null, 2));
    await this.store.updateArtifactStatus(spec.id, 'ready', { renderedPath });
    return { artifactId: spec.id, renderedPath };
  }
}
