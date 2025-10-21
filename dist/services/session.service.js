"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionService = exports.SessionService = void 0;
const uuid_1 = require("uuid");
class SessionService {
    constructor() {
        this.sessions = new Map();
    }
    async createSession(userId, initialQuery) {
        const sessionId = this.generateId();
        const session = {
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
    async getSession(sessionId) {
        return this.sessions.get(sessionId) ?? null;
    }
    async getUserSessions(userId) {
        return Array.from(this.sessions.values())
            .filter((session) => session.userId === userId)
            .sort((a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime());
    }
    async updateSession(sessionId, updates) {
        const session = await this.getSession(sessionId);
        if (!session)
            throw new Error('Session not found');
        Object.assign(session, updates);
        session.lastAccessedAt = new Date();
        this.sessions.set(sessionId, session);
        return session;
    }
    async addMessage(sessionId, message) {
        const session = await this.getSession(sessionId);
        if (!session)
            throw new Error('Session not found');
        const newMessage = {
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
    async addInterpretiveResult(sessionId, result) {
        const session = await this.getSession(sessionId);
        if (!session)
            throw new Error('Session not found');
        session.lastInterpretiveResult = result;
        session.metadata.mode = result.mode;
        session.metadata.totalTokens += result.metadata?.groqTokens?.total ?? 0;
        this.sessions.set(sessionId, session);
        return session;
    }
    async addDocument(sessionId, document) {
        const session = await this.getSession(sessionId);
        if (!session)
            throw new Error('Session not found');
        session.uploadedDocuments.push(document);
        session.metadata.documentCount = session.uploadedDocuments.length;
        this.sessions.set(sessionId, session);
        return session;
    }
    async addArtifact(sessionId, artifact) {
        const session = await this.getSession(sessionId);
        if (!session)
            throw new Error('Session not found');
        session.generatedArtifacts.push(artifact);
        session.metadata.artifactCount = session.generatedArtifacts.length;
        this.sessions.set(sessionId, session);
        return session;
    }
    async deleteSession(sessionId) {
        return this.sessions.delete(sessionId);
    }
    createInitialMetadata() {
        return {
            messageCount: 0,
            documentCount: 0,
            artifactCount: 0,
            mode: null,
            topics: [],
            totalTokens: 0,
        };
    }
    generateTitle(query) {
        const words = query.trim().split(/\s+/);
        return words.slice(0, 5).join(' ') + (words.length > 5 ? '...' : '');
    }
    extractTopics(messages) {
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
    generateId() {
        return `${Date.now()}_${(0, uuid_1.v4)()}`;
    }
}
exports.SessionService = SessionService;
exports.sessionService = new SessionService();
