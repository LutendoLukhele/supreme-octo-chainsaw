import { NeonQueryFunction } from '@neondatabase/serverless';
import { CompiledWorkflowPlan, WorkflowSpec } from '@aso/workflow-contracts';

export interface WorkflowSpecRow {
  id: string;
  user_id: string | null;
  session_id: string | null;
  source: string;
  display_text: string;
  spec_json: WorkflowSpec;
  compiled_plan_json: CompiledWorkflowPlan;
  created_at: string | Date;
  updated_at: string | Date;
}

export class WorkflowStore {
  constructor(private readonly sql: NeonQueryFunction<false, false>) {}

  async saveWorkflow(workflow: WorkflowSpec, compiledPlan: CompiledWorkflowPlan): Promise<void> {
    await this.sql`
      INSERT INTO workflow_specs (
        id, user_id, session_id, source, display_text, spec_json, compiled_plan_json
      ) VALUES (
        ${workflow.id},
        ${workflow.metadata.userId ?? null},
        ${workflow.metadata.sessionId ?? null},
        ${workflow.source},
        ${workflow.displayText},
        ${JSON.stringify(workflow)},
        ${JSON.stringify(compiledPlan)}
      )
      ON CONFLICT (id) DO UPDATE SET
        display_text = EXCLUDED.display_text,
        spec_json = EXCLUDED.spec_json,
        compiled_plan_json = EXCLUDED.compiled_plan_json,
        updated_at = NOW()
    `;
  }

  async getWorkflowByIdForUser(id: string, userId: string): Promise<WorkflowSpecRow | null> {
    const rows = await this.sql`
      SELECT id, user_id, session_id, source, display_text, spec_json, compiled_plan_json,
             created_at, updated_at
      FROM workflow_specs
      WHERE id = ${id}
        AND user_id = ${userId}
      LIMIT 1
    ` as WorkflowSpecRow[];
    return rows[0] ?? null;
  }
}
