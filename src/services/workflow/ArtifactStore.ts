import { NeonQueryFunction } from '@neondatabase/serverless';
import {
  ArtifactSpec,
  ArtifactStatus,
  DocumentGenerationMode,
} from '@aso/workflow-contracts';

export interface ArtifactDeliveryMetadata {
  renderedPath?: string;
  renderedFilename?: string;
  byteLength?: number;
  generationMode?: DocumentGenerationMode;
  previewRows?: string[][];
  previewText?: string;
}

interface WorkflowArtifactRow {
  id: string;
  workflow_id: string;
  workflow_step_id: string;
  kind: ArtifactSpec['kind'];
  format: ArtifactSpec['format'];
  title: string;
  sections_json: ArtifactSpec['sections'];
  bindings_json: ArtifactSpec['bindings'];
  status: ArtifactStatus;
  rendered_path: string | null;
  rendered_filename: string | null;
  byte_length: number | string | null;
  generation_mode: DocumentGenerationMode | null;
  preview_rows_json: string[][] | null;
  preview_text: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export class ArtifactStore {
  constructor(private readonly sql: NeonQueryFunction<false, false>) {}

  async saveArtifacts(artifacts: ArtifactSpec[]): Promise<void> {
    for (const artifact of artifacts) {
      await this.sql`
        INSERT INTO workflow_artifacts (
          id, workflow_id, workflow_step_id, kind, format, title, sections_json,
          bindings_json, status, rendered_path, rendered_filename, byte_length,
          generation_mode, preview_rows_json, preview_text
        ) VALUES (
          ${artifact.id},
          ${artifact.workflowId},
          ${artifact.workflowStepId},
          ${artifact.kind},
          ${artifact.format},
          ${artifact.title},
          ${JSON.stringify(artifact.sections)},
          ${JSON.stringify(artifact.bindings)},
          ${artifact.status},
          ${artifact.renderedPath ?? null},
          ${artifact.renderedFilename ?? null},
          ${artifact.byteLength ?? null},
          ${artifact.generationMode ?? null},
          ${artifact.previewRows ? JSON.stringify(artifact.previewRows) : null},
          ${artifact.previewText ?? null}
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          rendered_path = EXCLUDED.rendered_path,
          rendered_filename = EXCLUDED.rendered_filename,
          byte_length = EXCLUDED.byte_length,
          generation_mode = EXCLUDED.generation_mode,
          preview_rows_json = EXCLUDED.preview_rows_json,
          preview_text = EXCLUDED.preview_text,
          bindings_json = EXCLUDED.bindings_json,
          updated_at = NOW()
      `;
    }
  }

  async updateArtifactStatus(
    id: string,
    status: ArtifactStatus,
    metadata: ArtifactDeliveryMetadata = {},
  ): Promise<void> {
    await this.sql`
      UPDATE workflow_artifacts
      SET status = ${status},
          rendered_path = ${metadata.renderedPath ?? null},
          rendered_filename = ${metadata.renderedFilename ?? null},
          byte_length = ${metadata.byteLength ?? null},
          generation_mode = ${metadata.generationMode ?? null},
          preview_rows_json = ${metadata.previewRows ? JSON.stringify(metadata.previewRows) : null},
          preview_text = ${metadata.previewText ?? null},
          updated_at = NOW()
      WHERE id = ${id}
    `;
  }

  async getArtifactById(id: string): Promise<ArtifactSpec | null> {
    const rows = await this.sql`
      SELECT id, workflow_id, workflow_step_id, kind, format, title, sections_json,
             bindings_json, status, rendered_path, rendered_filename, byte_length,
             generation_mode, preview_rows_json, preview_text, created_at, updated_at
      FROM workflow_artifacts
      WHERE id = ${id}
      LIMIT 1
    ` as WorkflowArtifactRow[];
    return rows[0] ? this.fromRow(rows[0]) : null;
  }

  async listArtifactsByWorkflowId(workflowId: string): Promise<ArtifactSpec[]> {
    const rows = await this.sql`
      SELECT id, workflow_id, workflow_step_id, kind, format, title, sections_json,
             bindings_json, status, rendered_path, rendered_filename, byte_length,
             generation_mode, preview_rows_json, preview_text, created_at, updated_at
      FROM workflow_artifacts
      WHERE workflow_id = ${workflowId}
      ORDER BY created_at ASC
    ` as WorkflowArtifactRow[];
    return rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: WorkflowArtifactRow): ArtifactSpec {
    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowStepId: row.workflow_step_id,
      kind: row.kind,
      format: row.format,
      title: row.title,
      sections: row.sections_json,
      bindings: row.bindings_json,
      status: row.status,
      renderedPath: row.rendered_path ?? undefined,
      renderedFilename: row.rendered_filename ?? undefined,
      byteLength: row.byte_length == null ? undefined : Number(row.byte_length),
      generationMode: row.generation_mode ?? undefined,
      previewRows: row.preview_rows_json ?? undefined,
      previewText: row.preview_text ?? undefined,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }
}
