import { NeonQueryFunction } from '@neondatabase/serverless';
import { CompiledWorkflowPlan, WorkflowSpec } from '@aso/workflow-contracts';

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
}
