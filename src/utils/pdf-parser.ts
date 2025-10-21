// src/utils/pdf-parser.ts

import pdfParse from 'pdf-parse';
import fs from 'fs';

interface PDFStructuredData {
    paragraphs: string[];
    tables: string[][];
    lists: string[];
}

export interface PDFResult {
    text: string;
    pageCount: number;
    imageCount: number;
    structured: PDFStructuredData;
}

export class PDFParser {
    public async parse(filepath: string): Promise<PDFResult> {
        const dataBuffer = fs.readFileSync(filepath);
        const data = await pdfParse(dataBuffer);

        return {
            text: data.text ?? '',
            pageCount: data.numpages ?? 0,
            imageCount: data.numrender ?? 0,
            structured: this.extractStructure(data.text ?? ''),
        };
    }

    private extractStructure(text: string): PDFStructuredData {
        const lines = text.split('\n').map((line) => line.trim());

        return {
            paragraphs: this.extractParagraphs(lines),
            tables: this.extractTables(lines),
            lists: this.extractLists(lines),
        };
    }

    private extractParagraphs(lines: string[]): string[] {
        const paragraphs: string[] = [];
        let currentParagraph = '';

        lines.forEach((line) => {
            if (!line) {
                if (currentParagraph) {
                    paragraphs.push(currentParagraph.trim());
                    currentParagraph = '';
                }
            } else {
                currentParagraph += `${line} `;
            }
        });

        if (currentParagraph) {
            paragraphs.push(currentParagraph.trim());
        }

        return paragraphs;
    }

    private extractTables(lines: string[]): string[][] {
        return lines
            .filter((line) => line.includes('|') || line.includes('\t'))
            .map((line) => line.split(/\||\t/).map((cell) => cell.trim()))
            .filter((row) => row.length > 1);
    }

    private extractLists(lines: string[]): string[] {
        return lines
            .filter((line) => /^[-*•]/.test(line))
            .map((line) => line.replace(/^[-*•]\s*/, '').trim());
    }
}
