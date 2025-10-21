// src/models/session.model.ts

import { InterpretiveResponse } from './interpretive.model';
import { Document } from './document.model';
import { Artifact } from './artifact.model';

export type MessageRole = 'user' | 'assistant';
export type MessageType = 'text' | 'interpretive' | 'artifact' | 'document';

export interface Message {
    id: string;
    role: MessageRole;
    content: string | InterpretiveResponse | Artifact | Document;
    timestamp: Date;
    type: MessageType;
    metadata?: Record<string, unknown>;
}

export interface SessionMetadata {
    messageCount: number;
    documentCount: number;
    artifactCount: number;
    mode: InterpretiveResponse['mode'] | null;
    topics: string[];
    totalTokens: number;
}

export interface Session {
    id: string;
    userId: string;
    title: string;
    createdAt: Date;
    lastAccessedAt: Date;
    messages: Message[];
    lastInterpretiveResult: InterpretiveResponse | null;
    uploadedDocuments: Document[];
    generatedArtifacts: Artifact[];
    metadata: SessionMetadata;
}
