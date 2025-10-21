"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocxParser = void 0;
const mammoth_1 = __importDefault(require("mammoth"));
const fs_1 = __importDefault(require("fs"));
class DocxParser {
    async parse(filepath) {
        const buffer = fs_1.default.readFileSync(filepath);
        const result = await mammoth_1.default.extractRawText({ buffer });
        const text = result.value ?? '';
        const paragraphs = text.split('\n').map((p) => p.trim()).filter(Boolean);
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
exports.DocxParser = DocxParser;
