// src/models/artifact.model.ts

export type ArtifactType = 'code' | 'visualization' | 'analysis' | 'export';
export type ArtifactStatus = 'generating' | 'ready' | 'executing' | 'completed' | 'error';

export interface ArtifactMetadata {
    linesOfCode?: number;
    dependencies?: string[];
    executionTimeMs?: number | null;
}

export interface ExecutionResult {
    success: boolean;
    output?: string;
    error?: string;
    toolCalls?: any[];
    executionTime?: number | null;
}

export interface Artifact {
    id: string;
    userId: string;
    sessionId?: string;
    type: ArtifactType;
    title: string;
    content: string;
    language?: string;
    createdAt: Date;
    executionResult?: ExecutionResult;
    status: ArtifactStatus;
    metadata: ArtifactMetadata;
}
