// src/utils/docx-parser.ts

import mammoth from 'mammoth';
import fs from 'fs';

export interface DocxResult {
    text: string;
    wordCount: number;
    imageCount: number;
    structured: {
        paragraphs: string[];
    };
}

export class DocxParser {
    public async parse(filepath: string): Promise<DocxResult> {
        const buffer = fs.readFileSync(filepath);
        const result = await mammoth.extractRawText({ buffer });
        const text = result.value ?? '';
        const paragraphs = text.split('\n').map((p: any) => p.trim()).filter(Boolean);
        const wordCount = text ? text.split(/\s+/).length : 0;

        return {
            text,
            wordCount,
            imageCount: 0,
            structured: {
                paragraphs,
            },
        };
    }
}