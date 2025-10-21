"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PDFParser = void 0;
const pdf_parse_1 = __importDefault(require("pdf-parse"));
const fs_1 = __importDefault(require("fs"));
class PDFParser {
    async parse(filepath) {
        const dataBuffer = fs_1.default.readFileSync(filepath);
        const data = await (0, pdf_parse_1.default)(dataBuffer);
        return {
            text: data.text ?? '',
            pageCount: data.numpages ?? 0,
            imageCount: data.numrender ?? 0,
            structured: this.extractStructure(data.text ?? ''),
        };
    }
    extractStructure(text) {
        const lines = text.split('\n').map((line) => line.trim());
        return {
            paragraphs: this.extractParagraphs(lines),
            tables: this.extractTables(lines),
            lists: this.extractLists(lines),
        };
    }
    extractParagraphs(lines) {
        const paragraphs = [];
        let currentParagraph = '';
        lines.forEach((line) => {
            if (!line) {
                if (currentParagraph) {
                    paragraphs.push(currentParagraph.trim());
                    currentParagraph = '';
                }
            }
            else {
                currentParagraph += `${line} `;
            }
        });
        if (currentParagraph) {
            paragraphs.push(currentParagraph.trim());
        }
        return paragraphs;
    }
    extractTables(lines) {
        return lines
            .filter((line) => line.includes('|') || line.includes('\t'))
            .map((line) => line.split(/\||\t/).map((cell) => cell.trim()))
            .filter((row) => row.length > 1);
    }
    extractLists(lines) {
        return lines
            .filter((line) => /^[-*•]/.test(line))
            .map((line) => line.replace(/^[-*•]\s*/, '').trim());
    }
}
exports.PDFParser = PDFParser;
