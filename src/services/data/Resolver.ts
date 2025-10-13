import { DataDependencyService } from './DataDependencyService';

export class Resolver {
    constructor(private dataDependencyService: DataDependencyService) {}

    async resolve(planId: string, input: any): Promise<any> {
        if (typeof input === 'string') {
            let resolvedInput = input;

            // Resolve step placeholders
            const stepRegex = /{{step:([^.}]+)\.([^}|]+)(?:\|([^}]+))?}}/g;
            let stepMatch;
            while ((stepMatch = stepRegex.exec(input)) !== null) {
                const [fullMatch, stepId, path, helper] = stepMatch;
                const stepResult = this.dataDependencyService.getStepResult(planId, stepId);
                let value;
                if (stepResult) {
                    value = this.getValueByPath(stepResult.rawOutput, path);
                }

                if (value !== undefined) {
                    if (helper) {
                        value = this.applyHelpers(value, helper);
                    }
                    resolvedInput = resolvedInput.replace(fullMatch, value);
                } else {
                    const fallback = this.getFallbackValue(helper);
                    if (fallback !== undefined) {
                        resolvedInput = resolvedInput.replace(fullMatch, fallback);
                    }
                }
            }

            // Resolve plan placeholders
            const planRegex = /{{plan:([^}]+)(?:\|([^}]+))?}}/g;
            let planMatch;
            while ((planMatch = planRegex.exec(resolvedInput)) !== null) {
                const [fullMatch, tag, helper] = planMatch;
                const value = this.dataDependencyService.getPlanData(planId, tag);
                if (value !== undefined) {
                    resolvedInput = resolvedInput.replace(fullMatch, value);
                } else {
                    const fallback = this.getFallbackValue(helper);
                    if (fallback !== undefined) {
                        resolvedInput = resolvedInput.replace(fullMatch, fallback);
                    }
                }
            }

            return resolvedInput;
        } else if (Array.isArray(input)) {
            return Promise.all(input.map(item => this.resolve(planId, item)));
        } else if (typeof input === 'object' && input !== null) {
            const resolvedObject: Record<string, any> = {};
            for (const key in input) {
                resolvedObject[key] = await this.resolve(planId, input[key]);
            }
            return resolvedObject;
        }
        return input;
    }

    private getFallbackValue(helper?: string): string | undefined {
        if (!helper) {
            return undefined;
        }
        const fallbackRegex = /fallback\((.*)\)/;
        const fallbackMatch = helper.match(fallbackRegex);
        if (fallbackMatch) {
            return fallbackMatch[1];
        }
        return undefined;
    }

    private applyHelpers(value: any, helper: string): any {
        const truncateRegex = /truncate\((\d+)\)/;
        const truncateMatch = helper.match(truncateRegex);
        if (truncateMatch) {
            const length = parseInt(truncateMatch[1], 10);
            if (typeof value === 'string') {
                return value.length > length ? value.substring(0, length) + '...' : value;
            }
        }

        const extractRegex = /extract\("([^"]+)"\)/;
        const extractMatch = helper.match(extractRegex);
        if (extractMatch) {
            const field = extractMatch[1];
            if (typeof value === 'object' && value !== null && field in value) {
                return value[field];
            }
        }

        return value;
    }

    private getValueByPath(obj: any, path: string): any {
        const keys = path.split('.');
        let value = obj;
        for (const key of keys) {
            if (value && typeof value === 'object' && key in value) {
                value = value[key];
            } else {
                return undefined;
            }
        }
        return value;
    }
}
