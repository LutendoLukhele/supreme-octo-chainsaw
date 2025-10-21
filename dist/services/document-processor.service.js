"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.documentProcessorService = exports.DocumentProcessorService = void 0;
const fs_1 = __importDefault(require("fs"));
const csv_parser_1 = __importDefault(require("csv-parser"));
const pdf_parser_1 = require("../utils/pdf-parser");
const excel_parser_1 = require("../utils/excel-parser");
const docx_parser_1 = require("../utils/docx-parser");
class DocumentProcessorService {
    constructor() {
        this.pdfParser = new pdf_parser_1.PDFParser();
        this.excelParser = new excel_parser_1.ExcelParser();
        this.docxParser = new docx_parser_1.DocxParser();
    }
    async process(file) {
        const document = {
            id: this.generateId(),
            userId: '',
            filename: file.originalname,
            fileType: this.getFileType(file.originalname),
            fileSizeBytes: file.size,
            uploadedAt: new Date(),
            status: 'processing',
            metadata: {},
        };
        try {
            switch (document.fileType) {
                case 'pdf': {
                    const pdfResult = await this.pdfParser.parse(file.path);
                    document.processedContent = pdfResult.text;
                    document.extractedData = pdfResult.structured;
                    document.metadata = {
                        pageCount: pdfResult.pageCount,
                        imageCount: pdfResult.imageCount,
                    };
                    break;
                }
                case 'xlsx':
                case 'xls': {
                    const excelResult = await this.excelParser.parse(file.path);
                    document.processedContent = excelResult.text;
                    document.extractedData = excelResult.sheets;
                    document.metadata = {
                        sheetCount: excelResult.sheetCount,
                        tableCount: excelResult.tableCount,
                    };
                    break;
                }
                case 'docx':
                case 'doc': {
                    const docxResult = await this.docxParser.parse(file.path);
                    document.processedContent = docxResult.text;
                    document.extractedData = docxResult.structured;
                    document.metadata = {
                        wordCount: docxResult.wordCount,
                        imageCount: docxResult.imageCount,
                    };
                    break;
                }
                case 'csv': {
                    const csvResult = await this.parseCSV(file.path);
                    document.processedContent = csvResult.text;
                    document.extractedData = csvResult.data;
                    document.metadata = {
                        rowCount: csvResult.rowCount,
                    };
                    break;
                }
                default:
                    throw new Error(`Unsupported file type: ${document.fileType}`);
            }
            document.status = 'ready';
        }
        catch (error) {
            document.status = 'error';
            document.error = error?.message ?? 'Failed to process document';
        }
        finally {
            fs_1.default.unlink(file.path, () => {
            });
        }
        return document;
    }
    getFileType(filename) {
        const extension = filename.split('.').pop()?.toLowerCase();
        if (!extension)
            throw new Error(`Unable to determine file type for ${filename}`);
        return extension;
    }
    parseCSV(filepath) {
        return new Promise((resolve, reject) => {
            const rows = [];
            fs_1.default.createReadStream(filepath)
                .pipe((0, csv_parser_1.default)())
                .on('data', (row) => rows.push(row))
                .on('end', () => {
                const text = rows.map((row) => Object.values(row).join(', ')).join('\n');
                resolve({
                    data: rows,
                    text,
                    rowCount: rows.length,
                });
            })
                .on('error', reject);
        });
    }
    generateId() {
        return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }
}
exports.DocumentProcessorService = DocumentProcessorService;
exports.documentProcessorService = new DocumentProcessorService();
