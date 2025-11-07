// src/services/session.service.ts

import { v4 as uuidv4 } from 'uuid';
import * as storage from 'node-persist';
import { Session, Message, SessionMetadata } from '../models/session.model';
import { InterpretiveResponse } from '../models/interpretive.model';
import { Document } from '../models/document.model';
import { Artifact } from '../models/artifact.model';

export class SessionService {
    private storage: storage.LocalStorage;

    constructor() {
        this.storage = storage.create({
            dir: '.data/sessions',
            ttl: false,
        });
    }

    public async init() {
        await this.storage.init();
    }

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

        await this.storage.setItem(sessionId, session);
        return session;
    }

    public async getSession(sessionId: string): Promise<Session | null> {
        return (await this.storage.getItem(sessionId)) ?? null;
    }

    public async getUserSessions(userId: string): Promise<Session[]> {
        const sessions: Session[] = await this.storage.values();
        return sessions
            .filter((session) => session.userId === userId)
            .sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime());
    }

    public async updateSession(sessionId: string, updates: Partial<Session>): Promise<Session> {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        const updatedSession = { ...session, ...updates, lastAccessedAt: new Date() };
        await this.storage.setItem(sessionId, updatedSession);
        return updatedSession;
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

        await this.storage.setItem(sessionId, session);
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

        await this.storage.setItem(sessionId, session);
        return session;
    }

    public async addDocument(sessionId: string, document: Document): Promise<Session> {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        session.uploadedDocuments.push(document);
        session.metadata.documentCount = session.uploadedDocuments.length;

        await this.storage.setItem(sessionId, session);
        return session;
    }

    public async addArtifact(sessionId: string, artifact: Artifact): Promise<Session> {
        const session = await this.getSession(sessionId);
        if (!session) throw new Error('Session not found');

        session.generatedArtifacts.push(artifact);
        session.metadata.artifactCount = session.generatedArtifacts.length;

        await this.storage.setItem(sessionId, session);
        return session;
    }

    public async deleteSession(sessionId: string): Promise<void> {
        await this.storage.removeItem(sessionId);
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
