"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionService = exports.SessionService = void 0;
const uuid_1 = require("uuid");
const storage = __importStar(require("node-persist"));
class SessionService {
    constructor() {
        this.storage = storage.create({
            dir: '.data/sessions',
            ttl: false,
        });
    }
    async init() {
        await this.storage.init();
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
        await this.storage.setItem(sessionId, session);
        return session;
    }
    async getSession(sessionId) {
        return (await this.storage.getItem(sessionId)) ?? null;
    }
    async getUserSessions(userId) {
        const sessions = await this.storage.values();
        return sessions
            .filter((session) => session.userId === userId)
            .sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime());
    }
    async updateSession(sessionId, updates) {
        const session = await this.getSession(sessionId);
        if (!session)
            throw new Error('Session not found');
        const updatedSession = { ...session, ...updates, lastAccessedAt: new Date() };
        await this.storage.setItem(sessionId, updatedSession);
        return updatedSession;
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
        await this.storage.setItem(sessionId, session);
        return session;
    }
    async addInterpretiveResult(sessionId, result) {
        const session = await this.getSession(sessionId);
        if (!session)
            throw new Error('Session not found');
        session.lastInterpretiveResult = result;
        session.metadata.mode = result.mode;
        session.metadata.totalTokens += result.metadata?.groqTokens?.total ?? 0;
        await this.storage.setItem(sessionId, session);
        return session;
    }
    async addDocument(sessionId, document) {
        const session = await this.getSession(sessionId);
        if (!session)
            throw new Error('Session not found');
        session.uploadedDocuments.push(document);
        session.metadata.documentCount = session.uploadedDocuments.length;
        await this.storage.setItem(sessionId, session);
        return session;
    }
    async addArtifact(sessionId, artifact) {
        const session = await this.getSession(sessionId);
        if (!session)
            throw new Error('Session not found');
        session.generatedArtifacts.push(artifact);
        session.metadata.artifactCount = session.generatedArtifacts.length;
        await this.storage.setItem(sessionId, session);
        return session;
    }
    async deleteSession(sessionId) {
        await this.storage.removeItem(sessionId);
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
