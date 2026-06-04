import { v4 as uuidv4 } from 'uuid';
import {
  ArtifactSpec,
  CompiledWorkflowActionNode,
  CompiledWorkflowPlan,
  WorkflowDependency,
  WorkflowSpec,
  WorkflowStep,
} from '@aso/workflow-contracts';
import { ActionPlan, ActionStep } from '../PlannerService';

export interface WorkflowCompilationResult {
  compiledPlan: CompiledWorkflowPlan;
  actionPlan: ActionPlan;
  artifactSpecs: ArtifactSpec[];
}

export class WorkflowCompilerService {
  compile(workflow: WorkflowSpec): WorkflowCompilationResult {
    const artifactSpecs: ArtifactSpec[] = [];
    const nodes: CompiledWorkflowActionNode[] = [];
    const actionEdges: WorkflowDependency[] = [];
    const terminalActionByWorkflowStep = new Map<string, string>();

    for (const workflowStep of workflow.steps) {
      const upstreamActionDependencies = workflowStep.dependsOn
        .map((dependencyId) => terminalActionByWorkflowStep.get(dependencyId))
        .filter((value): value is string => Boolean(value));

      const queryNodeId = this.makeNodeId(workflowStep.id, 'query');
      nodes.push({
        id: queryNodeId,
        workflowStepId: workflowStep.id,
        tool: workflowStep.query.tool,
        intent: this.queryIntent(workflowStep),
        arguments: workflowStep.query.arguments,
        dependsOn: upstreamActionDependencies,
      });

      upstreamActionDependencies.forEach((dependencyId) =>
        actionEdges.push({ fromStepId: dependencyId, toStepId: queryNodeId }),
      );

      const outputNode = this.compileOutputNode(workflow, workflowStep, queryNodeId);
      if (outputNode.artifactSpec) artifactSpecs.push(outputNode.artifactSpec);
      nodes.push(outputNode.node);
      actionEdges.push({ fromStepId: queryNodeId, toStepId: outputNode.node.id });
      terminalActionByWorkflowStep.set(workflowStep.id, outputNode.node.id);
    }

    const compiledPlan: CompiledWorkflowPlan = {
      workflowId: workflow.id,
      nodes,
      edges: actionEdges,
    };

    return {
      compiledPlan,
      actionPlan: nodes.map((node, index) => ({
        id: node.id,
        intent: node.intent,
        tool: node.tool,
        arguments: node.arguments,
        status: 'ready',
        stepNumber: index + 1,
        totalSteps: nodes.length,
        dependsOn: node.dependsOn,
        workflowStepId: node.workflowStepId,
        artifactSpecId: node.artifactSpecId,
      } as ActionStep)),
      artifactSpecs,
    };
  }

  private compileOutputNode(
    workflow: WorkflowSpec,
    step: WorkflowStep,
    queryNodeId: string,
  ): { node: CompiledWorkflowActionNode; artifactSpec?: ArtifactSpec } {
    const common = {
      id: this.makeNodeId(step.id, 'output'),
      workflowStepId: step.id,
      dependsOn: [queryNodeId],
    };

    if (step.output.kind === 'internal_email_drafts') {
      const artifactSpec = this.createArtifactSpec(workflow, step);
      return {
        artifactSpec,
        node: {
          ...common,
          tool: 'create_internal_email_draft',
          intent: 'Create internal follow-up email drafts',
          arguments: {
            input: {
              operation: 'create',
              artifactSpecId: artifactSpec.id,
              artifactSpec,
              sourceData: `{{${queryNodeId}.result}}`,
            },
          },
          artifactSpecId: artifactSpec.id,
        },
      };
    }

    if (step.output.kind === 'artifact' && step.output.artifact) {
      const artifactSpec = this.createArtifactSpec(workflow, step);
      return {
        artifactSpec,
        node: {
          ...common,
          tool: 'generate_file',
          intent: `Generate ${step.output.artifact.format.toUpperCase()} ${step.output.artifact.kind}`,
          arguments: {
            input: {
              operation: 'generate',
              format: step.output.artifact.format,
              title: artifactSpec.title,
              template: step.output.artifact.template,
              artifactSpecId: artifactSpec.id,
              artifactSpec,
              data: `{{${queryNodeId}.result}}`,
            },
          },
          artifactSpecId: artifactSpec.id,
        },
      };
    }

    switch (step.output.kind) {
      case 'calendar_blocks':
        return {
          node: {
            ...common,
            tool: 'create_calendar_event',
            intent: 'Create review calendar block',
            arguments: {
              input: {
                operation: 'create',
                summary: '{{PLACEHOLDER_event_title}}',
                start: '{{PLACEHOLDER_start_time}}',
                end: '{{PLACEHOLDER_end_time}}',
              },
            },
          },
        };
      case 'notion_page':
        return {
          node: {
            ...common,
            tool: 'create_notion_page',
            intent: 'Create structured Notion summary page',
            arguments: {
              input: {
                operation: 'create',
                parent: { type: 'workspace', workspace: true },
                properties: {
                  title: '{{PLACEHOLDER_page_title}}',
                },
                children: [],
              },
            },
          },
        };
      case 'slack_post':
        return {
          node: {
            ...common,
            tool: 'send_slack_message',
            intent: 'Post concise update to Slack',
            arguments: {
              input: {
                operation: 'send',
                channel: '{{PLACEHOLDER_channel}}',
                text: `{{${queryNodeId}.result}}`,
              },
            },
          },
        };
      default:
        throw new Error(`Unsupported workflow output kind: ${step.output.kind}`);
    }
  }

  private createArtifactSpec(workflow: WorkflowSpec, step: WorkflowStep): ArtifactSpec {
    if (!step.output.artifact) {
      throw new Error(`Workflow step ${step.id} has no artifact output metadata`);
    }
    const now = new Date().toISOString();
    return {
      id: `artifact_${uuidv4()}`,
      workflowId: workflow.id,
      workflowStepId: step.id,
      kind: step.output.artifact.kind,
      format: step.output.artifact.format,
      title: this.artifactTitle(step),
      sections: step.output.artifact.kind === 'email_draft'
        ? [{ kind: 'drafts', title: 'Drafts' }]
        : [
            { kind: 'summary', title: 'Summary' },
            { kind: 'table', title: 'Details' },
            { kind: 'recommendations', title: 'Recommended Actions' },
          ],
      bindings: {},
      status: 'compiled',
      createdAt: now,
      updatedAt: now,
    };
  }

  private artifactTitle(step: WorkflowStep): string {
    if (step.output.artifact?.kind === 'email_draft') return 'Follow-up Email Drafts';
    if (step.output.artifact?.kind === 'executive_brief') return 'Executive Brief';
    if (step.output.artifact?.kind === 'summary_document') return 'Word Summary';
    return 'Workflow Report';
  }

  private queryIntent(step: WorkflowStep): string {
    return `Fetch ${step.displayText.replace(/^Find\s+/i, '').split(' and ')[0]}`;
  }

  private makeNodeId(workflowStepId: string, suffix: string): string {
    return `${workflowStepId}_${suffix}_${uuidv4().slice(0, 8)}`;
  }
}
