"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.documentService = exports.DocumentService = void 0;
class DocumentService {
    constructor() {
        this.documents = new Map();
    }
    async save(document) {
        this.documents.set(document.id, document);
    }
    async getDocument(id) {
        return this.documents.get(id) ?? null;
    }
    async getDocuments(ids) {
        return ids
            .map((id) => this.documents.get(id))
            .filter((doc) => Boolean(doc));
    }
}
exports.DocumentService = DocumentService;
exports.documentService = new DocumentService();
