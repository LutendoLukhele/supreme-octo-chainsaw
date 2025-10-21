// src/models/interpretive.model.ts

export type Mode = 'TARGETED' | 'EXPLORATORY' | 'ANALYTICAL';
export type Status = 'loading' | 'complete' | 'error';

export interface ImageSource {
    url: string;
    attribution?: string;
    license?: string;
}

export interface ImageCandidate {
    url: string;
    caption: string;
    imageSource?: ImageSource | null;
}

export interface HeroSegment {
    headline: string;
    subheadline: string;
    imageUrl: string | null;
    imageSource: ImageSource | null;
    backgroundColor?: string;
    imageCandidates?: ImageCandidate[];
}

export interface TextSegment {
    type: 'text';
    text: string;
    sourceIndices?: number[];
}

export interface ImageSegment {
    type: 'image';
    imageUrl: string;
    caption: string;
    imageSource: ImageSource;
}

export interface InsightSegment {
    type: 'insight';
    title: string;
    data: string[] | Record<string, unknown>;
}

export interface QuoteSegment {
    type: 'quote';
    text: string;
    attribution?: string;
    sourceIndex?: number;
}

export interface ContextSegment {
    type: 'context';
    title: string;
    summary: string;
    bullets?: string[];
    tone?: string;
    sourceIndices?: number[];
}

export type Segment = TextSegment | ImageSegment | InsightSegment | QuoteSegment | ContextSegment;

export type SourceType =
    | 'linkedin'
    | 'news'
    | 'academic'
    | 'company'
    | 'industry'
    | 'blog'
    | 'review'
    | 'official'
    | 'benchmark';

export interface Source {
    index: number;
    title: string;
    url: string;
    domain: string;
    type: SourceType;
    relevanceScore?: number;
}

export interface ResponseMetadata {
    mode: Mode;
    processingTimeMs: number;
    segmentCount: number;
    sourceCount: number;
    groqModel: string;
    groqTokens: {
        prompt: number;
        completion: number;
        total: number;
    };
    groqReasoning?: string;
    groqExecutedTools?: unknown;
    groqParseStatus?: 'ok' | 'repaired' | 'fallback';
    researchNotes?: {
        baseReasoning?: string;
        enrichment?: Record<string, string | undefined>;
    };
}

export interface InterpretiveResponse {
    id: string;
    mode: Mode;
    status: Status;
    timestamp: string;
    hero: HeroSegment;
    segments: Segment[];
    sources: Source[];
    metadata: ResponseMetadata;
    artifact?: unknown;
}

export interface ErrorResponse {
    id: string;
    status: 'error';
    error: {
        code: string;
        message: string;
        details?: unknown;
    };
    fallback?: InterpretiveResponse;
}
