"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contentTransformer = exports.ContentTransformer = void 0;
const marked_1 = require("marked");
class ContentTransformer {
    async transform(content, format) {
        const base = {
            title: content.hero?.headline ?? 'Research Summary',
            topics: this.extractTopics(content),
            hero: content.hero,
            segments: content.segments,
            sources: content.sources,
        };
        switch (format) {
            case 'markdown':
                return { ...base, markdown: this.toMarkdown(content) };
            case 'html':
                return { ...base, html: this.toHTML(content) };
            case 'plaintext':
                return { ...base, plaintext: this.toPlaintext(content) };
            case 'json':
                return { ...base, json: JSON.stringify(content, null, 2) };
            default:
                return { ...base, markdown: this.toMarkdown(content) };
        }
    }
    toMarkdown(content) {
        let md = '';
        const { hero } = content;
        if (hero) {
            md += `# ${hero.headline}\n\n`;
            if (hero.subheadline) {
                md += `_${hero.subheadline}_\n\n`;
            }
            if (hero.imageUrl) {
                md += `![${hero.headline}](${hero.imageUrl})\n\n`;
            }
        }
        content.segments?.forEach((segment) => {
            if (segment.type === 'text') {
                md += `${segment.text}\n\n`;
            }
            else if (segment.type === 'image') {
                md += `![${segment.caption}](${segment.imageUrl})\n`;
                md += `_${segment.caption}_\n\n`;
            }
            else if (segment.type === 'insight') {
                md += `## ${segment.title}\n\n`;
                if (Array.isArray(segment.data)) {
                    segment.data.forEach((item) => {
                        md += `- ${item}\n`;
                    });
                    md += '\n';
                }
                else {
                    md += '```json\n';
                    md += JSON.stringify(segment.data, null, 2);
                    md += '\n```\n\n';
                }
            }
            else if (segment.type === 'quote') {
                md += `> ${segment.text}\n`;
                if (segment.attribution) {
                    md += `> \n> — ${segment.attribution}\n`;
                }
                md += '\n';
            }
        });
        if (content.sources?.length) {
            md += '## Sources\n\n';
            content.sources.forEach((source) => {
                md += `${source.index}. [${source.title}](${source.url}) (${source.domain})\n`;
            });
        }
        return md;
    }
    toHTML(content) {
        const markdown = this.toMarkdown(content);
        return marked_1.marked.parse(markdown);
    }
    toPlaintext(content) {
        let text = '';
        const { hero } = content;
        if (hero) {
            text += `${hero.headline}\n`;
            if (hero.subheadline) {
                text += `${hero.subheadline}\n`;
            }
            text += '\n';
        }
        content.segments?.forEach((segment) => {
            text += this.segmentToPlaintext(segment);
        });
        if (content.sources?.length) {
            text += 'Sources:\n';
            content.sources.forEach((source) => {
                text += `${source.index}. ${source.title} (${source.url})\n`;
            });
        }
        return text;
    }
    segmentToPlaintext(segment) {
        switch (segment.type) {
            case 'text':
                return `${segment.text}\n\n`;
            case 'insight': {
                let block = `${segment.title}\n`;
                if (Array.isArray(segment.data)) {
                    segment.data.forEach((item) => {
                        block += `- ${item}\n`;
                    });
                }
                else {
                    block += `${JSON.stringify(segment.data)}\n`;
                }
                return `${block}\n`;
            }
            case 'quote': {
                let block = `"${segment.text}"\n`;
                if (segment.attribution) {
                    block += `— ${segment.attribution}\n`;
                }
                return `${block}\n`;
            }
            case 'image':
                return `${segment.caption} (${segment.imageUrl})\n\n`;
            default:
                return '';
        }
    }
    extractTopics(content) {
        const topics = [];
        content.segments?.forEach((segment) => {
            if (segment.type === 'insight') {
                topics.push(segment.title);
            }
        });
        return topics;
    }
}
exports.ContentTransformer = ContentTransformer;
exports.contentTransformer = new ContentTransformer();
