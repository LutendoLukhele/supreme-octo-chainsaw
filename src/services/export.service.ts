// src/services/export.service.ts

import { InterpretiveResponse } from '../models/interpretive.model';
import { contentTransformer, TransformedContent } from '../utils/content-transformer';

export type ExportDestination = 'gmail' | 'salesforce' | 'notion' | 'slack' | 'drive' | 'notes';
export type ExportFormat = 'markdown' | 'html' | 'plaintext' | 'json';

export interface ExportConfig {
    to?: string;
    userEmail?: string;
    databaseId?: string;
    defaultDatabaseId?: string;
    channel?: string;
    defaultChannel?: string;
    folderId?: string;
    objectType?: string;
    format?: ExportFormat;
}

export interface ExportResult {
    success: boolean;
    destinationUrl?: string;
    message: string;
    timestamp: string;
    error?: string;
    recordCount?: number;
    content?: string;
}

export class ExportService {
    public async export(
        content: InterpretiveResponse,
        destination: ExportDestination,
        format: ExportFormat,
        _userId: string,
        config: ExportConfig,
    ): Promise<ExportResult> {
        const transformed = await contentTransformer.transform(content, format);

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

    private async exportToGmail(content: TransformedContent, config: ExportConfig): Promise<ExportResult> {
        return this.notImplemented(
            'gmail',
            `No Gmail integration configured. Intended recipient: ${config.to ?? config.userEmail ?? 'unknown'}`,
        );
    }

    private async exportToSalesforce(content: TransformedContent): Promise<ExportResult> {
        return this.notImplemented('salesforce', `Records prepared: ${this.extractEntities(content).length}`);
    }

    private async exportToNotion(content: TransformedContent): Promise<ExportResult> {
        return this.notImplemented('notion', `Notion blocks prepared: ${this.convertToNotionBlocks(content).length}`);
    }

    private async exportToSlack(content: TransformedContent): Promise<ExportResult> {
        return this.notImplemented('slack', `Slack blocks prepared: ${this.convertToSlackBlocks(content).length}`);
    }

    private async exportToDrive(content: TransformedContent, format: ExportFormat): Promise<ExportResult> {
        const fileContent = format === 'html' ? content.html : content.markdown ?? content.plaintext;
        return this.notImplemented('drive', `File content length: ${fileContent?.length ?? 0}`);
    }

    private async exportToNotes(content: TransformedContent): Promise<ExportResult> {
        return {
            success: true,
            content: content.plaintext ?? this.fallbackPlaintext(content),
            message: 'Content prepared for notes',
            timestamp: new Date().toISOString(),
        };
    }

    private notImplemented(destination: ExportDestination, message?: string): ExportResult {
        return {
            success: false,
            message: `Export to ${destination} is not implemented.`,
            error: message,
            timestamp: new Date().toISOString(),
        };
    }

    private extractEntities(content: TransformedContent): Array<Record<string, unknown>> {
        const entities: Array<Record<string, unknown>> = [];

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

    private convertToNotionBlocks(content: TransformedContent): unknown[] {
        const blocks: unknown[] = [];
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
            } else if (segment.type === 'image') {
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
            } else if (segment.type === 'insight') {
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

    private convertToSlackBlocks(content: TransformedContent): unknown[] {
        const blocks: unknown[] = [];
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
            } else if (segment.type === 'insight') {
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
                        text:
                            '*Sources:* ' +
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

    private formatInsightData(data: unknown): string {
        if (Array.isArray(data)) {
            return data.map((item) => `• ${item}`).join('\n');
        }
        if (data && typeof data === 'object') {
            return Object.entries(data as Record<string, unknown>)
                .map(([key, value]) => `*${key}:* ${JSON.stringify(value)}`)
                .join('\n');
        }
        return String(data ?? '');
    }

    private fallbackPlaintext(content: TransformedContent): string {
        const parts: string[] = [];

        if (content.hero) {
            parts.push(content.hero.headline);
            if (content.hero.subheadline) {
                parts.push(content.hero.subheadline);
            }
        }

        content.segments?.forEach((segment) => {
            if (segment.type === 'text') {
                parts.push(segment.text);
            } else if (segment.type === 'insight') {
                parts.push(`${segment.title}: ${JSON.stringify(segment.data)}`);
            } else if (segment.type === 'quote') {
                parts.push(`"${segment.text}" ${segment.attribution ?? ''}`.trim());
            } else if (segment.type === 'image') {
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

export const exportService = new ExportService();
