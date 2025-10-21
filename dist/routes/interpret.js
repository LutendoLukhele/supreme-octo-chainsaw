"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const router_service_1 = require("../services/router.service");
const prompt_generator_service_1 = require("../services/prompt-generator.service");
const groq_service_1 = require("../services/groq.service");
const response_parser_service_1 = require("../services/response-parser.service");
const session_service_1 = require("../services/session.service");
const document_service_1 = require("../services/document.service");
const artifact_generator_service_1 = require("../services/artifact-generator.service");
const router = express_1.default.Router();
router.post('/', async (req, res) => {
    const requestId = generateRequestId();
    const startTime = Date.now();
    try {
        const { query, sessionId, documentIds, enableArtifacts, searchSettings } = req.body;
        if (!query) {
            res.status(400).json({ error: 'Query is required', id: requestId });
            return;
        }
        let sessionContext = null;
        if (sessionId) {
            sessionContext = await session_service_1.sessionService.getSession(sessionId);
            if (sessionContext) {
                await session_service_1.sessionService.addMessage(sessionId, {
                    role: 'user',
                    content: query,
                    type: 'text',
                });
            }
        }
        const documentContext = documentIds && documentIds.length
            ? await document_service_1.documentService.getDocuments(documentIds)
            : [];
        const { mode, entities } = await router_service_1.routerService.detectIntent(query);
        const groqPrompt = prompt_generator_service_1.promptGeneratorService.generatePrompt(mode, query, entities, {
            sessionContext,
            documentContext,
            enableArtifacts,
        });
        const groqResponse = await groq_service_1.groqService.executeSearch(groqPrompt, {
            searchSettings,
        });
        const interpretiveResponse = response_parser_service_1.responseParserService.parseGroqResponse(groqResponse.content, mode, groqResponse);
        interpretiveResponse.metadata.processingTimeMs = Date.now() - startTime;
        const enrichmentNotes = {};
        const enrichmentImageCandidates = [];
        const enrichmentDefinitions = [
            {
                key: 'cultural',
                searchSettings: {
                    include_domains: ['*.museum', '*.gallery', '*.art', 'cosmos.co', 'www.metmuseum.org'],
                },
            },
            {
                key: 'social',
                searchSettings: {
                    include_domains: ['*.substack.com', 'www.reddit.com', 'www.threads.net', 'www.tumblr.com'],
                },
            },
            {
                key: 'visual',
                searchSettings: {
                    include_domains: ['cosmos.co', '*.gallery', 'www.metmuseum.org', 'www.moma.org', 'www.wikiart.org'],
                },
            },
        ];
        await Promise.all(enrichmentDefinitions.map(async (definition) => {
            try {
                const enrichmentPrompt = prompt_generator_service_1.promptGeneratorService.generateEnrichmentPrompt(definition.key, query, entities);
                const combinedSearchSettings = mergeSearchSettings(searchSettings, definition.searchSettings);
                const enrichmentResponse = await groq_service_1.groqService.executeSearch(enrichmentPrompt, {
                    searchSettings: combinedSearchSettings,
                });
                const parsedEnrichment = response_parser_service_1.responseParserService.parseEnrichmentResponse(enrichmentResponse.content);
                enrichmentNotes[definition.key] = enrichmentResponse.reasoning;
                const localToGlobalIndex = new Map();
                parsedEnrichment.sources.forEach((source, idx) => {
                    const existingIndex = interpretiveResponse.sources.findIndex((existing) => existing.url === source.url);
                    if (existingIndex >= 0) {
                        localToGlobalIndex.set(idx + 1, existingIndex + 1);
                    }
                    else {
                        interpretiveResponse.sources.push({
                            ...source,
                            index: interpretiveResponse.sources.length + 1,
                        });
                        localToGlobalIndex.set(idx + 1, interpretiveResponse.sources.length);
                    }
                });
                parsedEnrichment.segments.forEach((segment) => {
                    if (segment.type === 'context' && Array.isArray(segment.sourceIndices)) {
                        segment.sourceIndices = segment.sourceIndices.map((localIndex) => localToGlobalIndex.get(localIndex) ?? localIndex);
                    }
                    if (segment.type === 'quote' && typeof segment.sourceIndex === 'number') {
                        segment.sourceIndex =
                            localToGlobalIndex.get(segment.sourceIndex) ?? segment.sourceIndex;
                    }
                    if (segment.type === 'context' && !segment.title?.toLowerCase().includes(definition.key)) {
                        segment.title = `${segment.title} (${definition.key})`;
                    }
                    interpretiveResponse.segments.push(segment);
                });
                enrichmentImageCandidates.push(...parsedEnrichment.imageCandidates);
            }
            catch (enrichmentError) {
                enrichmentNotes[definition.key] = `Failed to enrich: ${enrichmentError?.message ?? 'unknown error'}`;
            }
        }));
        interpretiveResponse.sources = interpretiveResponse.sources
            .filter((source, index, self) => self.findIndex((item) => item.url === source.url) === index)
            .map((source, index) => ({
            ...source,
            index: index + 1,
        }));
        const uniqueImageCandidates = [];
        const seenImages = new Set();
        enrichmentImageCandidates.forEach((candidate) => {
            if (!seenImages.has(candidate.url)) {
                seenImages.add(candidate.url);
                uniqueImageCandidates.push(candidate);
            }
        });
        if (!interpretiveResponse.hero.imageUrl && uniqueImageCandidates.length > 0) {
            const nextCandidate = uniqueImageCandidates[0];
            interpretiveResponse.hero.imageUrl = nextCandidate.url;
            interpretiveResponse.hero.imageSource = nextCandidate.imageSource ?? null;
        }
        interpretiveResponse.hero.imageCandidates = uniqueImageCandidates;
        interpretiveResponse.metadata.segmentCount = interpretiveResponse.segments.length;
        interpretiveResponse.metadata.sourceCount = interpretiveResponse.sources.length;
        interpretiveResponse.metadata.researchNotes = {
            baseReasoning: groqResponse.reasoning,
            enrichment: enrichmentNotes,
        };
        if (enableArtifacts && shouldGenerateArtifact(query, interpretiveResponse)) {
            const artifact = await artifact_generator_service_1.artifactGeneratorService.generateCodeArtifact({
                prompt: extractArtifactPrompt(query),
                language: detectLanguage(query),
                context: interpretiveResponse,
            });
            interpretiveResponse.artifact = artifact;
            if (sessionId) {
                await session_service_1.sessionService.addArtifact(sessionId, artifact);
            }
        }
        if (sessionId) {
            await session_service_1.sessionService.addMessage(sessionId, {
                role: 'assistant',
                content: interpretiveResponse,
                type: 'interpretive',
            });
            await session_service_1.sessionService.addInterpretiveResult(sessionId, interpretiveResponse);
        }
        res.json(interpretiveResponse);
    }
    catch (error) {
        res.status(500).json({
            id: requestId,
            status: 'error',
            error: {
                code: 'PROCESSING_ERROR',
                message: error?.message ?? 'Failed to process interpret request',
                details: error,
            },
        });
    }
});
function shouldGenerateArtifact(query, response) {
    const artifactKeywords = [
        'write code',
        'generate script',
        'create function',
        'analyze data',
        'visualize',
        'plot',
        'chart',
        'calculate',
    ];
    const lowered = query.toLowerCase();
    const keywordMatch = artifactKeywords.some((keyword) => lowered.includes(keyword));
    const responseFlag = Boolean(response.artifactNeeded);
    return keywordMatch || responseFlag;
}
function extractArtifactPrompt(query) {
    return query.replace(/^(please |can you |could you )/i, '').trim();
}
function detectLanguage(query) {
    const lowered = query.toLowerCase();
    if (lowered.includes('typescript') || lowered.includes('ts'))
        return 'typescript';
    if (lowered.includes('javascript') || lowered.includes('js'))
        return 'javascript';
    if (lowered.includes('python'))
        return 'python';
    if (lowered.includes('sql'))
        return 'sql';
    if (lowered.includes('bash') || lowered.includes('shell'))
        return 'bash';
    if (lowered.includes('analyze') || lowered.includes('visualize'))
        return 'python';
    return 'python';
}
function mergeSearchSettings(base, overlay) {
    if (!base && !overlay)
        return undefined;
    const includeDomains = new Set();
    const excludeDomains = new Set();
    (base?.include_domains ?? []).forEach((domain) => includeDomains.add(domain));
    (overlay?.include_domains ?? []).forEach((domain) => includeDomains.add(domain));
    (base?.exclude_domains ?? []).forEach((domain) => excludeDomains.add(domain));
    (overlay?.exclude_domains ?? []).forEach((domain) => excludeDomains.add(domain));
    const merged = {};
    if (includeDomains.size > 0)
        merged.include_domains = Array.from(includeDomains);
    if (excludeDomains.size > 0)
        merged.exclude_domains = Array.from(excludeDomains);
    merged.country = overlay?.country ?? base?.country;
    return Object.keys(merged).length > 0 ? merged : undefined;
}
function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}
exports.default = router;
