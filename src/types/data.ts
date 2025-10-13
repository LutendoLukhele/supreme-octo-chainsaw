export interface StepResult {
    planId: string;
    stepId: string;
    status: 'running' | 'completed' | 'failed';
    startedAt: Date;
    endedAt?: Date;
    rawOutput: any;
    summary?: string;
    extracted?: { [key: string]: any };
    attachments?: string[];
    logs?: string[];
    }
    