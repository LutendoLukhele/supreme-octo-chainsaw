"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.promptGeneratorService = exports.PromptGeneratorService = void 0;
class PromptGeneratorService {
    generatePrompt(mode, query, entities, context) {
        let prompt = this.getBasePrompt(mode, query, entities);
        if (context?.documentContext && context.documentContext.length > 0) {
            prompt += this.buildDocumentContext(context.documentContext);
        }
        if (context?.sessionContext && context.sessionContext.messages.length > 0) {
            prompt += this.buildSessionContext(context.sessionContext);
        }
        if (context?.enableArtifacts) {
            prompt += `\n\nIf the query requires code, analysis, or visualization, indicate this in your response by including an "artifactNeeded" field with type and description.\n`;
        }
        return prompt;
    }
    getBasePrompt(mode, query, entities) {
        switch (mode) {
            case 'TARGETED':
                return this.buildTargetedPrompt(query, entities);
            case 'ANALYTICAL':
                return this.buildAnalyticalPrompt(query);
            case 'EXPLORATORY':
            default:
                return this.buildExploratoryPrompt(query);
        }
    }
    buildTargetedPrompt(query, entities) {
        const entity = entities[0] ?? query;
        return `You will search the web for information about: ${entity}

After searching, respond with ONLY this JSON (no markdown, no explanation):

{
  "hero": {
    "headline": "Full name or best identifier",
    "subheadline": "Current role + company, or key identifier",
    "imageUrl": "Best image URL found (LinkedIn, company, headshot, or null)"
  },
  "narrative": [
    {
      "type": "paragraph",
      "text": "Who They Are - 2-3 sentence intro paragraph with personality"
    },
    {
      "type": "image",
      "imageUrl": "image URL found during search",
      "caption": "Descriptive caption for image"
    },
    {
      "type": "paragraph",
      "text": "Career Trajectory - 2-3 sentences on how they progressed"
    },
    {
      "type": "insight",
      "title": "Core Expertise",
      "data": ["expertise 1", "expertise 2", "expertise 3"]
    },
    {
      "type": "paragraph",
      "text": "Notable Achievements - 2-3 sentences on standout moments"
    }
  ],
  "sources": [
    {
      "title": "Source Title",
      "url": "full URL",
      "domain": "domain.com",
      "type": "linkedin|news|company",
      "relevanceScore": 0.95
    }
  ]
}

RULES:
- Use built-in web search results and citations. Map the top citations into the "sources" array with exact titles, full URLs, domains, and types.
- Include 2-3 viable image candidates from search (headshots/company pages). Choose the best one as "hero.imageUrl" and image narrative segment. If none resolve, set imageUrl to null.
- Make narrative conversational, not robotic; avoid fluff.
- Extract at least 3 high-quality sources and prioritize official/company/linkedin first.
- Validate URLs are absolute (http/https). No placeholders.
- Do NOT include any markdown or explanation outside the JSON`;
    }
    buildExploratoryPrompt(query) {
        return `You will search the web for comprehensive information about: ${query}

After searching, respond with ONLY this JSON:

{
  "hero": {
    "headline": "What is ${query}?",
    "subheadline": "Key insight or why it matters (1 sentence)",
    "imageUrl": "Best diagram, visualization, or example image URL (or null)"
  },
  "narrative": [
    {
      "type": "paragraph",
      "text": "Hook - Why this matters to readers (2-3 sentences)"
    },
    {
      "type": "paragraph",
      "text": "What It Is - Clear definition and context (3-4 sentences)"
    },
    {
      "type": "image",
      "imageUrl": "diagram or visualization URL",
      "caption": "Descriptive caption"
    },
    {
      "type": "paragraph",
      "text": "How It Works - Mechanism or process (3-4 sentences)"
    },
    {
      "type": "paragraph",
      "text": "Real Examples - Concrete applications with 2-3 specific examples (4 sentences)"
    },
    {
      "type": "insight",
      "title": "Key Statistics",
      "data": ["statistic 1", "statistic 2", "statistic 3"]
    },
    {
      "type": "paragraph",
      "text": "Why It Matters - Impact and implications (2-3 sentences)"
    }
  ],
  "sources": [
    {
      "title": "Source Title",
      "url": "full URL",
      "domain": "domain.com",
      "type": "academic|news|industry|blog",
      "relevanceScore": 0.85
    }
  ]
}

RULES:
- Use the compound system’s web search and citations; map citations into the "sources" array (title, URL, domain, type, relevanceScore).
- Write conversationally, like a guide explaining to a peer.
- Include 2-3 image URLs (diagrams/visualizations) and pick the best for hero and image segment.
- Provide real, sourced statistics; do not invent numbers.
- Ensure all URLs are absolute and accessible.
- Do NOT include markdown or explanation outside JSON`;
    }
    buildAnalyticalPrompt(query) {
        return `You will search the web for comparative information about: ${query}

After searching both, respond with ONLY this JSON:

{
  "hero": {
    "headline": "${query}",
    "subheadline": "Key differences and trade-offs",
    "imageUrl": "comparative visual or best representation (or null)"
  },
  "narrative": [
    {
      "type": "paragraph",
      "text": "Overview - What are these? Why compare? (3-4 sentences)"
    },
    {
      "type": "paragraph",
      "text": "Core Differences - How they fundamentally differ (3-4 sentences)"
    },
    {
      "type": "insight",
      "title": "Feature Comparison",
      "data": {
        "speed": {"item1": "value", "item2": "value"},
        "cost": {"item1": "value", "item2": "value"},
        "accuracy": {"item1": "value", "item2": "value"}
      }
    },
    {
      "type": "paragraph",
      "text": "Where Each Excels - Comparative strengths (3-4 sentences)"
    },
    {
      "type": "insight",
      "title": "Trade-Offs",
      "data": ["trade-off 1: what you gain/lose", "trade-off 2: what you gain/lose"]
    },
    {
      "type": "paragraph",
      "text": "Verdict - Who wins and for what use cases (3-4 sentences)"
    }
  ],
  "sources": [
    {
      "title": "Source Title",
      "url": "full URL",
      "domain": "domain.com",
      "type": "review|news|official|benchmark",
      "relevanceScore": 0.88
    }
  ]
}

RULES:
- Use the compound system’s search; map citations into the "sources" array with accurate titles and links (vendor docs, benchmarks, reputable reviews preferred).
- Be objective; include real comparison data (cost/speed/accuracy) with sources.
- Include a concise comparative visual URL if available; otherwise leave hero.imageUrl null.
- Validate URLs are absolute and accessible.
- Do NOT include markdown or explanation outside JSON`;
    }
    buildDocumentContext(documents) {
        const sections = documents.map((doc) => {
            const excerpt = doc.processedContent?.slice(0, 2000) ?? '';
            return `Document: ${doc.filename}\nContent:\n${excerpt}...\n`;
        });
        return `\n\nYou have access to the following uploaded documents:\n${sections.join('\n')}\nUse information from these documents when relevant to the query.\n`;
    }
    buildSessionContext(session) {
        const recent = session.messages.slice(-5);
        const lines = recent.map((msg) => {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            return `${msg.role}: ${content.slice(0, 200)}`;
        });
        return `\n\nRecent conversation context:\n${lines.join('\n')}\n`;
    }
    generateEnrichmentPrompt(enrichment, query, entities) {
        const subject = entities[0] ?? query;
        switch (enrichment) {
            case 'cultural':
                return `You will act as a cultural curator. Using web search, surface the nuanced cultural, artistic, and historical context around: ${subject}

Return ONLY this JSON:
{
  "segments": [
    {
      "type": "context",
      "title": "Concise headline for the cultural angle",
      "summary": "Short paragraph (2-3 sentences) weaving artistic, intellectual, or historical commentary",
      "bullets": ["Key motif or reference", "Notable critic or art historian quote", "Cultural comparison"],
      "tone": "reflective"
    },
    {
      "type": "quote",
      "text": "Short excerpt from curator/critic/artist",
      "attribution": "Name, Source",
      "sourceIndex": 1
    }
  ],
  "sources": [
    {
      "title": "Source Title",
      "url": "https://full.url",
      "domain": "domain.com",
      "type": "news|blog|academic|museum",
      "relevanceScore": 0.9
    }
  ],
  "imageCandidates": [
    {
      "url": "https://image-url",
      "caption": "Describe the visual or artwork",
      "imageSource": {
        "url": "https://source-url",
        "attribution": "Museum / Photographer",
        "license": "License if available"
      }
    }
  ]
}

RULES:
- Use art historians, curators, museum archives, cultural critics as primary sources.
- Blend insight and aesthetic storytelling; no fluff.
- If no high-quality image is available, return an empty array for imageCandidates.
- Do NOT include markdown or any text outside the JSON.`;
            case 'social':
                return `You are an analyst summarizing current social and community discourse around: ${subject}

Return ONLY this JSON:
{
  "segments": [
    {
      "type": "context",
      "title": "What communities are saying",
      "summary": "2-3 sentence synthesis of current debates, enthusiasm, or concerns from social media/forums",
      "bullets": ["Key theme #1", "Key theme #2", "Key theme #3"],
      "tone": "observational"
    },
    {
      "type": "quote",
      "text": "Representative pull-quote from a post or thread",
      "attribution": "@handle or Platform",
      "sourceIndex": 1
    }
  ],
  "sources": [
    {
      "title": "Thread or Article Title",
      "url": "https://full.url",
      "domain": "domain.com",
      "type": "blog|forum|social",
      "relevanceScore": 0.85
    }
  ],
  "imageCandidates": []
}

RULES:
- Focus on recent (last 3-6 months) posts or discussions (X, Reddit, niche forums, Substack, Discord recaps).
- Highlight contrasting perspectives when available.
- Avoid unsourced claims; cite each insight.
- Do NOT include markdown or explanation outside JSON.`;
            case 'visual':
            default:
                return `You are a visual scout finding evocative imagery for: ${subject}

Return ONLY this JSON:
{
  "segments": [
    {
      "type": "context",
      "title": "Visual Motifs",
      "summary": "Short paragraph describing the dominant visual aesthetics pulled from the imagery you find.",
      "bullets": ["Motif or palette detail", "Composition note", "Symbolic element"],
      "tone": "descriptive"
    }
  ],
  "sources": [
    {
      "title": "Source Title",
      "url": "https://full.url",
      "domain": "domain.com",
      "type": "gallery|museum|photography",
      "relevanceScore": 0.9
    }
  ],
  "imageCandidates": [
    {
      "url": "https://image-url",
      "caption": "Describe the visual succinctly",
      "imageSource": {
        "url": "https://source-url",
        "attribution": "Artist / Photographer",
        "license": "License or usage note"
      }
    },
    {
      "url": "https://image-url",
      "caption": "Second option",
      "imageSource": {
        "url": "https://source-url",
        "attribution": "Artist / Photographer",
        "license": "License or usage note"
      }
    }
  ]
}

RULES:
- Prioritize high-resolution imagery from reputable galleries, photography archives, or cosmos.co style art sources.
- Do not invent URLs; if unsure, leave array empty.
- Returned segments should stay under 120 words total.
- Do NOT include markdown or explanation outside JSON.`;
        }
    }
}
exports.PromptGeneratorService = PromptGeneratorService;
exports.promptGeneratorService = new PromptGeneratorService();
