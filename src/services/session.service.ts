// src/services/session.service.ts

import { v4 as uuidv4 } from 'uuid';
import { Session, Message, SessionMetadata } from '../models/session.model';
import { InterpretiveResponse } from '../models/interpretive.model';
import { Document } from '../models/document.model';
import { Artifact } from '../models/artifact.model';

export class SessionService {
    private sessions: Map<string, Session> = new Map();

    public async createSession(userId: string, initialQuery?: string): Promise<Session> {
        const sessionId = this.generateId();

        const session: Session = {
            id: sessionId,
            userId,
            title: initialQuery ? this.generateTitle(initialQuery) : 'New Session',
            createdAt: new Date(),
            lastAccessedAt: new Date(),
            messages: [],
            lastInterpretiveResult: null,
            uploadedDocuments: [],
            generatedArtifacts: [],
            metadata: this.createInitialMetadata(),
        };

        this.sessions.set(sessionId, session);
        return session;
    }

    public async getSession(sessionId: string): Promise<Session | null> {
        return this.sessions.get(sessionId) ?? null;
    }

    public async getUserSessions(userId: string): Promise<Session[]> {
        return Array.from(this.sessions.values())
            .filter((session) => session.userId === userId)
            .sort((a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime());
    }

    public async updateSession(sessionId: string, updates: Partial<Session>): Promise<Session> {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        Object.assign(session, updates);
        session.lastAccessedAt = new Date();
        this.sessions.set(sessionId, session);
        return session;
    }

    public async addMessage(
        sessionId: string,
        message: Omit<Message, 'id' | 'timestamp'>,
    ): Promise<Session> {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        const newMessage: Message = {
            id: this.generateId(),
            ...message,
            timestamp: new Date(),
        };

        session.messages.push(newMessage);
        session.metadata.messageCount = session.messages.length;
        session.metadata.topics = this.extractTopics(session.messages);
        session.lastAccessedAt = new Date();

        this.sessions.set(sessionId, session);
        return session;
    }

    public async addInterpretiveResult(
        sessionId: string,
        result: InterpretiveResponse,
    ): Promise<Session> {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        session.lastInterpretiveResult = result;
        session.metadata.mode = result.mode;
        session.metadata.totalTokens += result.metadata?.groqTokens?.total ?? 0;

        this.sessions.set(sessionId, session);
        return session;
    }

    public async addDocument(sessionId: string, document: Document): Promise<Session> {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        session.uploadedDocuments.push(document);
        session.metadata.documentCount = session.uploadedDocuments.length;

        this.sessions.set(sessionId, session);
        return session;
    }

    public async addArtifact(sessionId: string, artifact: Artifact): Promise<Session> {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        session.generatedArtifacts.push(artifact);
        session.metadata.artifactCount = session.generatedArtifacts.length;

        this.sessions.set(sessionId, session);
        return session;
    }

    public async deleteSession(sessionId: string): Promise<boolean> {
        return this.sessions.delete(sessionId);
    }

    private createInitialMetadata(): SessionMetadata {
        return {
            messageCount: 0,
            documentCount: 0,
            artifactCount: 0,
            mode: null,
            topics: [],
            totalTokens: 0,
        };
    }

    private generateTitle(query: string): string {
        const words = query.trim().split(/\s+/);
        return words.slice(0, 5).join(' ') + (words.length > 5 ? '...' : '');
    }

    private extractTopics(messages: Message[]): string[] {
        const userContent = messages
            .filter((msg) => msg.role === 'user')
            .map((msg) => (typeof msg.content === 'string' ? msg.content : ''))
            .join(' ');

        const keywords = userContent
            .toLowerCase()
            .split(/\s+/)
            .filter((word) => word.length > 5)
            .slice(0, 5);

        return Array.from(new Set(keywords));
    }

    private generateId(): string {
        return `${Date.now()}_${uuidv4()}`;
    }
}

export const sessionService = new SessionService();
