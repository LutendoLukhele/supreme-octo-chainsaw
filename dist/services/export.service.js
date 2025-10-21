"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportService = exports.ExportService = void 0;
const content_transformer_1 = require("../utils/content-transformer");
class ExportService {
    async export(content, destination, format, _userId, config) {
        const transformed = await content_transformer_1.contentTransformer.transform(content, format);
        switch (destination) {
            case 'gmail':
                return this.exportToGmail(transformed, config);
            case 'salesforce':
                return this.exportToSalesforce(transformed);
            case 'notion':
                return this.exportToNotion(transformed);
            case 'slack':
                return this.exportToSlack(transformed);
            case 'drive':
                return this.exportToDrive(transformed, format);
            case 'notes':
                return this.exportToNotes(transformed);
            default:
                return this.notImplemented(destination);
        }
    }
    async exportToGmail(content, config) {
        return this.notImplemented('gmail', `No Gmail integration configured. Intended recipient: ${config.to ?? config.userEmail ?? 'unknown'}`);
    }
    async exportToSalesforce(content) {
        return this.notImplemented('salesforce', `Records prepared: ${this.extractEntities(content).length}`);
    }
    async exportToNotion(content) {
        return this.notImplemented('notion', `Notion blocks prepared: ${this.convertToNotionBlocks(content).length}`);
    }
    async exportToSlack(content) {
        return this.notImplemented('slack', `Slack blocks prepared: ${this.convertToSlackBlocks(content).length}`);
    }
    async exportToDrive(content, format) {
        const fileContent = format === 'html' ? content.html : content.markdown ?? content.plaintext;
        return this.notImplemented('drive', `File content length: ${fileContent?.length ?? 0}`);
    }
    async exportToNotes(content) {
        return {
            success: true,
            content: content.plaintext ?? this.fallbackPlaintext(content),
            message: 'Content prepared for notes',
            timestamp: new Date().toISOString(),
        };
    }
    notImplemented(destination, message) {
        return {
            success: false,
            message: `Export to ${destination} is not implemented.`,
            error: message,
            timestamp: new Date().toISOString(),
        };
    }
    extractEntities(content) {
        const entities = [];
        content.segments?.forEach((segment) => {
            if (segment.type === 'insight' && Array.isArray(segment.data)) {
                segment.data.forEach((item) => {
                    entities.push({
                        Name: item,
                        Type: segment.title,
                    });
                });
            }
        });
        return entities;
    }
    convertToNotionBlocks(content) {
        const blocks = [];
        const hero = content.hero;
        if (hero) {
            blocks.push({
                type: 'heading_1',
                heading_1: {
                    rich_text: [{ text: { content: hero.headline } }],
                },
            });
            if (hero.subheadline) {
                blocks.push({
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ text: { content: hero.subheadline } }],
                    },
                });
            }
            if (hero.imageUrl) {
                blocks.push({
                    type: 'image',
                    image: {
                        type: 'external',
                        external: { url: hero.imageUrl },
                    },
                });
            }
        }
        content.segments?.forEach((segment) => {
            if (segment.type === 'text') {
                blocks.push({
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ text: { content: segment.text } }],
                    },
                });
            }
            else if (segment.type === 'image') {
                blocks.push({
                    type: 'image',
                    image: {
                        type: 'external',
                        external: { url: segment.imageUrl },
                    },
                });
                blocks.push({
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [
                            {
                                text: { content: segment.caption },
                                annotations: { italic: true },
                            },
                        ],
                    },
                });
            }
            else if (segment.type === 'insight') {
                blocks.push({
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ text: { content: segment.title } }],
                    },
                });
                if (Array.isArray(segment.data)) {
                    segment.data.forEach((item) => {
                        blocks.push({
                            type: 'bulleted_list_item',
                            bulleted_list_item: {
                                rich_text: [{ text: { content: item } }],
                            },
                        });
                    });
                }
            }
        });
        if (content.sources?.length) {
            blocks.push({
                type: 'heading_3',
                heading_3: {
                    rich_text: [{ text: { content: 'Sources' } }],
                },
            });
            content.sources.forEach((source) => {
                blocks.push({
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [
                            { text: { content: `[${source.index}] ` } },
                            {
                                text: { content: source.title, link: { url: source.url } },
                                annotations: { bold: true },
                            },
                            { text: { content: ` (${source.domain})` } },
                        ],
                    },
                });
            });
        }
        return blocks;
    }
    convertToSlackBlocks(content) {
        const blocks = [];
        const hero = content.hero;
        if (hero) {
            blocks.push({
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: hero.headline,
                },
            });
            if (hero.subheadline) {
                blocks.push({
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: hero.subheadline,
                    },
                });
            }
            if (hero.imageUrl) {
                blocks.push({
                    type: 'image',
                    image_url: hero.imageUrl,
                    alt_text: hero.headline,
                });
            }
        }
        blocks.push({ type: 'divider' });
        content.segments?.slice(0, 10).forEach((segment) => {
            if (segment.type === 'text') {
                blocks.push({
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: segment.text,
                    },
                });
            }
            else if (segment.type === 'insight') {
                blocks.push({
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `*${segment.title}*\n${this.formatInsightData(segment.data)}`,
                    },
                });
            }
        });
        if (content.sources?.length) {
            blocks.push({ type: 'divider' });
            blocks.push({
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: '*Sources:* ' +
                            content.sources
                                .slice(0, 3)
                                .map((source) => `<${source.url}|${source.domain}>`)
                                .join(' • '),
                    },
                ],
            });
        }
        return blocks;
    }
    formatInsightData(data) {
        if (Array.isArray(data)) {
            return data.map((item) => `• ${item}`).join('\n');
        }
        if (data && typeof data === 'object') {
            return Object.entries(data)
                .map(([key, value]) => `*${key}:* ${JSON.stringify(value)}`)
                .join('\n');
        }
        return String(data ?? '');
    }
    fallbackPlaintext(content) {
        const parts = [];
        if (content.hero) {
            parts.push(content.hero.headline);
            if (content.hero.subheadline) {
                parts.push(content.hero.subheadline);
            }
        }
        content.segments?.forEach((segment) => {
            if (segment.type === 'text') {
                parts.push(segment.text);
            }
            else if (segment.type === 'insight') {
                parts.push(`${segment.title}: ${JSON.stringify(segment.data)}`);
            }
            else if (segment.type === 'quote') {
                parts.push(`"${segment.text}" ${segment.attribution ?? ''}`.trim());
            }
            else if (segment.type === 'image') {
                parts.push(`${segment.caption} (${segment.imageUrl})`);
            }
        });
        if (content.sources?.length) {
            parts.push('Sources:');
            content.sources.forEach((source) => {
                parts.push(`${source.index}. ${source.title} (${source.url})`);
            });
        }
        return parts.join('\n\n');
    }
}
exports.ExportService = ExportService;
exports.exportService = new ExportService();
