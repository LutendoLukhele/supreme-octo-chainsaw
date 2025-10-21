// src/services/response-parser.service.ts

import {
    HeroSegment,
    Segment,
    Source,
    ResponseMetadata,
    Mode,
    InterpretiveResponse,
    ImageCandidate,
    ImageSource,
} from '../models/interpretive.model';

interface GroqRawResponse {
    content: string;
    model: string;
    usage: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    reasoning?: string;
    executedTools?: unknown;
}

export class ResponseParserService {
    public parseGroqResponse(
        groqContent: string,
        mode: Mode,
        groqResponse: GroqRawResponse,
    ): InterpretiveResponse {
        const { payload, parseStatus } = this.prepareGroqPayload(groqContent);

        const hero = this.buildHero(payload.hero);
        const segments = this.buildSegments(payload.narrative ?? []);
        const sources = this.buildSources(payload.sources ?? []);
        const metadata = this.buildMetadata(mode, payload, groqResponse, parseStatus);

        return {
            id: this.generateId(),
            mode,
            status: 'complete',
            timestamp: new Date().toISOString(),
            hero,
            segments,
            sources,
            metadata,
            artifact: payload.artifact ?? undefined,
        };
    }

    public parseEnrichmentResponse(content: string): {
        segments: Segment[];
        sources: Source[];
        imageCandidates: ImageCandidate[];
    } {
        try {
            const { payload } = this.prepareGroqPayload(content ?? '{}');
            const segments = this.buildSegments(payload.segments ?? []);
            const sources = this.buildSources(payload.sources ?? []);
            const imageCandidates = (payload.imageCandidates ?? [])
                .filter((candidate: any) => typeof candidate?.url === 'string' && candidate.url.trim().length > 0)
                .map((candidate: any) => ({
                    url: candidate.url,
                    caption: candidate.caption ?? '',
                    imageSource: candidate.imageSource
                        ? {
                              url: candidate.imageSource.url ?? candidate.url,
                              attribution: candidate.imageSource.attribution,
                              license: candidate.imageSource.license,
                          }
                        : null,
                })) as ImageCandidate[];

            return {
                segments,
                sources,
                imageCandidates,
            };
        } catch (error: any) {
            throw new Error(`Failed to parse enrichment response: ${error?.message ?? 'Invalid JSON'}`);
        }
    }

    public buildFallbackResponse(
        rawContent: string,
        mode: Mode,
        groqResponse: GroqRawResponse,
        reason: string,
    ): InterpretiveResponse {
        const metadata = this.buildMetadata(
            mode,
            {},
            groqResponse,
            'fallback',
        );
        metadata.researchNotes = {
            ...(metadata.researchNotes ?? {}),
            baseReasoning: groqResponse.reasoning,
            enrichment: {
                ...(metadata.researchNotes?.enrichment ?? {}),
                parseFallback: reason,
            },
        };

        return {
            id: this.generateId(),
            mode,
            status: 'complete',
            timestamp: new Date().toISOString(),
            hero: {
                headline: 'Unable to parse Groq response',
                subheadline: reason,
                imageUrl: null,
                imageSource: null,
                imageCandidates: [],
            },
            segments: [
                {
                    type: 'text',
                    text: rawContent.trim().length > 0
                        ? `Raw Groq output:\n${rawContent.trim()}`
                        : 'Groq returned an empty payload.',
                },
            ],
            sources: [],
            metadata: {
                ...metadata,
                segmentCount: 1,
                sourceCount: 0,
                groqParseStatus: 'fallback',
            },
            artifact: undefined,
        };
    }

    private buildHero(heroData: any): HeroSegment {
        return {
            headline: heroData?.headline ?? 'Untitled',
            subheadline: heroData?.subheadline ?? '',
            imageUrl: heroData?.imageUrl ?? null,
            imageSource: heroData?.imageUrl
                ? {
                      url: heroData.imageUrl,
                      attribution: heroData?.imageSource?.attribution,
                      license: heroData?.imageSource?.license,
                  }
                : null,
        };
    }

    private buildSegments(narrative: any[]): Segment[] {
        return narrative.map((segment) => {
            switch (segment.type) {
                case 'paragraph':
                case 'text':
                    return {
                        type: 'text',
                        text: segment.text ?? '',
                        sourceIndices: segment.sourceIndices,
                    } as Segment;
                case 'image':
                    return {
                        type: 'image',
                        imageUrl: segment.imageUrl ?? '',
                        caption: segment.caption ?? '',
                        imageSource: {
                            url: segment.imageUrl ?? '',
                            attribution: segment.imageSource?.attribution,
                            license: segment.imageSource?.license,
                        },
                    } as Segment;
                case 'insight':
                    return {
                        type: 'insight',
                        title: segment.title ?? '',
                        data: segment.data ?? [],
                    } as Segment;
                case 'quote':
                    return {
                        type: 'quote',
                        text: segment.text ?? '',
                        attribution: segment.attribution,
                        sourceIndex: segment.sourceIndex,
                    } as Segment;
                case 'context':
                    return {
                        type: 'context',
                        title: segment.title ?? segment.heading ?? 'Context',
                        summary: segment.summary ?? segment.text ?? '',
                        bullets: Array.isArray(segment.bullets) ? segment.bullets : undefined,
                        tone: segment.tone,
                        sourceIndices: segment.sourceIndices,
                    } as Segment;
                default:
                    return {
                        type: 'text',
                        text: typeof segment === 'string' ? segment : JSON.stringify(segment),
                    } as Segment;
            }
        });
    }

    private buildSources(sources: any[]): Source[] {
        return sources.map((source, index) => ({
            index: index + 1,
            title: source.title ?? 'Untitled Source',
            url: source.url ?? '',
            domain: source.domain ?? this.extractDomain(source.url ?? ''),
            type: source.type ?? 'blog',
            relevanceScore: source.relevanceScore ?? 0.5,
        }));
    }

    private buildMetadata(
        mode: Mode,
        parsed: any,
        groqResponse: GroqRawResponse,
        parseStatus: 'ok' | 'repaired' | 'fallback',
    ): ResponseMetadata {
        return {
            mode,
            processingTimeMs: 0,
            segmentCount: parsed?.narrative?.length ?? 0,
            sourceCount: parsed?.sources?.length ?? 0,
            groqModel: groqResponse.model ?? '',
            groqTokens: {
                prompt: groqResponse.usage.prompt_tokens ?? 0,
                completion: groqResponse.usage.completion_tokens ?? 0,
                total: groqResponse.usage.total_tokens ?? 0,
            },
            groqReasoning: groqResponse.reasoning,
            groqExecutedTools: groqResponse.executedTools,
            groqParseStatus: parseStatus,
        };
    }

    private extractDomain(url: string): string {
        try {
            const parsed = new URL(url);
            return parsed.hostname;
        } catch {
            return '';
        }
    }

    private generateId(): string {
        return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }

    private prepareGroqPayload(rawContent: string): { payload: any; parseStatus: 'ok' | 'repaired' } {
        const cleaned = this.stripCodeFences(rawContent);
        const candidate = this.extractJsonObject(cleaned);
        let parseStatus: 'ok' | 'repaired' = candidate.modified ? 'repaired' : 'ok';

        try {
            const parsed = JSON.parse(candidate.content);
            this.assertInterpretiveShape(parsed);
            if (parseStatus === 'ok' && candidate.modified) {
                parseStatus = 'repaired';
            }
            return {
                payload: parsed,
                parseStatus,
            };
        } catch (error: any) {
            const message = error?.message ?? 'Invalid JSON';
            throw new Error(`Failed to parse Groq response: ${message}`);
        }
    }

    private stripCodeFences(content: string): string {
        const trimmed = content.trim();
        if (trimmed.startsWith('```')) {
            const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
            if (fenceMatch) {
                return fenceMatch[1];
            }
        }
        return trimmed;
    }

    private extractJsonObject(content: string): { content: string; modified: boolean } {
        const firstBrace = content.indexOf('{');
        const lastBrace = content.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
            return { content, modified: false };
        }

        if (firstBrace !== 0 || lastBrace !== content.length - 1) {
            return {
                content: content.slice(firstBrace, lastBrace + 1),
                modified: true,
            };
        }

        return { content, modified: false };
    }

    private assertInterpretiveShape(parsed: any): void {
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Interpretive payload must be a JSON object.');
        }

        if (parsed.hero && typeof parsed.hero !== 'object') {
            throw new Error('Interpretive payload hero must be an object.');
        }

        if (parsed.narrative && !Array.isArray(parsed.narrative)) {
            throw new Error('Interpretive payload narrative must be an array.');
        }

        if (parsed.sources && !Array.isArray(parsed.sources)) {
            throw new Error('Interpretive payload sources must be an array.');
        }
    }
}

export const responseParserService = new ResponseParserService();
