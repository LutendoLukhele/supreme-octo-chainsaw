// src/models/document.model.ts

export type FileType = 'pdf' | 'xlsx' | 'xls' | 'docx' | 'doc' | 'csv';
export type DocumentStatus = 'uploading' | 'processing' | 'ready' | 'error';

export interface DocumentMetadata {
    pageCount?: number;
    sheetCount?: number;
    wordCount?: number;
    tableCount?: number;
    imageCount?: number;
    rowCount?: number;
}

export interface Document {
    id: string;
    userId: string;
    sessionId?: string;
    filename: string;
    fileType: FileType;
    fileSizeBytes: number;
    uploadedAt: Date;
    status: DocumentStatus;
    processedContent?: string;
    extractedData?: unknown;
    metadata: DocumentMetadata;
    error?: string;
}
