"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.responseParserService = exports.ResponseParserService = void 0;
class ResponseParserService {
    parseGroqResponse(groqContent, mode, groqResponse) {
        let parsed;
        try {
            parsed = JSON.parse(groqContent);
        }
        catch (error) {
            throw new Error(`Failed to parse Groq response: ${error?.message ?? 'Invalid JSON'}`);
        }
        const hero = this.buildHero(parsed.hero);
        const segments = this.buildSegments(parsed.narrative ?? []);
        const sources = this.buildSources(parsed.sources ?? []);
        const metadata = this.buildMetadata(mode, parsed, groqResponse);
        return {
            id: this.generateId(),
            mode,
            status: 'complete',
            timestamp: new Date().toISOString(),
            hero,
            segments,
            sources,
            metadata,
            artifact: parsed.artifact ?? undefined,
        };
    }
    parseEnrichmentResponse(content) {
        try {
            const parsed = JSON.parse(content ?? '{}');
            const segments = this.buildSegments(parsed.segments ?? []);
            const sources = this.buildSources(parsed.sources ?? []);
            const imageCandidates = (parsed.imageCandidates ?? [])
                .filter((candidate) => typeof candidate?.url === 'string' && candidate.url.trim().length > 0)
                .map((candidate) => ({
                url: candidate.url,
                caption: candidate.caption ?? '',
                imageSource: candidate.imageSource
                    ? {
                        url: candidate.imageSource.url ?? candidate.url,
                        attribution: candidate.imageSource.attribution,
                        license: candidate.imageSource.license,
                    }
                    : null,
            }));
            return {
                segments,
                sources,
                imageCandidates,
            };
        }
        catch (error) {
            throw new Error(`Failed to parse enrichment response: ${error?.message ?? 'Invalid JSON'}`);
        }
    }
    buildHero(heroData) {
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
    buildSegments(narrative) {
        return narrative.map((segment) => {
            switch (segment.type) {
                case 'paragraph':
                case 'text':
                    return {
                        type: 'text',
                        text: segment.text ?? '',
                        sourceIndices: segment.sourceIndices,
                    };
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
                    };
                case 'insight':
                    return {
                        type: 'insight',
                        title: segment.title ?? '',
                        data: segment.data ?? [],
                    };
                case 'quote':
                    return {
                        type: 'quote',
                        text: segment.text ?? '',
                        attribution: segment.attribution,
                        sourceIndex: segment.sourceIndex,
                    };
                case 'context':
                    return {
                        type: 'context',
                        title: segment.title ?? segment.heading ?? 'Context',
                        summary: segment.summary ?? segment.text ?? '',
                        bullets: Array.isArray(segment.bullets) ? segment.bullets : undefined,
                        tone: segment.tone,
                        sourceIndices: segment.sourceIndices,
                    };
                default:
                    return {
                        type: 'text',
                        text: typeof segment === 'string' ? segment : JSON.stringify(segment),
                    };
            }
        });
    }
    buildSources(sources) {
        return sources.map((source, index) => ({
            index: index + 1,
            title: source.title ?? 'Untitled Source',
            url: source.url ?? '',
            domain: source.domain ?? this.extractDomain(source.url ?? ''),
            type: source.type ?? 'blog',
            relevanceScore: source.relevanceScore ?? 0.5,
        }));
    }
    buildMetadata(mode, parsed, groqResponse) {
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
        };
    }
    extractDomain(url) {
        try {
            const parsed = new URL(url);
            return parsed.hostname;
        }
        catch {
            return '';
        }
    }
    generateId() {
        return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }
}
exports.ResponseParserService = ResponseParserService;
exports.responseParserService = new ResponseParserService();
