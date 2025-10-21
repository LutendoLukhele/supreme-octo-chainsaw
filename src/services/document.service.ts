// src/services/document.service.ts

import { Document } from '../models/document.model';

export class DocumentService {
    private documents: Map<string, Document> = new Map();

    public async save(document: Document): Promise<void> {
        this.documents.set(document.id, document);
    }

    public async getDocument(id: string): Promise<Document | null> {
        return this.documents.get(id) ?? null;
    }

    public async getDocuments(ids: string[]): Promise<Document[]> {
        return ids
            .map((id) => this.documents.get(id))
            .filter((doc): doc is Document => Boolean(doc));
    }
}

export const documentService = new DocumentService();
