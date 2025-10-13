import { StepResult } from '../../types/data';

export class DataDependencyService {
    private stepResults: Map<string, Map<string, StepResult>> = new Map();

    private planData: Map<string, Map<string, any>> = new Map();

    saveStepResult(result: StepResult): void {
        if (!this.stepResults.has(result.planId)) {
            this.stepResults.set(result.planId, new Map());
        }
        this.stepResults.get(result.planId)!.set(result.stepId, result);
    }

    getStepResult(planId: string, stepId: string): StepResult | undefined {
        return this.stepResults.get(planId)?.get(stepId);
    }

    savePlanData(planId: string, tag: string, data: any): void {
        if (!this.planData.has(planId)) {
            this.planData.set(planId, new Map());
        }
        this.planData.get(planId)!.set(tag, data);
    }

    getPlanData(planId: string, tag: string): any | undefined {
        return this.planData.get(planId)?.get(tag);
    }
}
