// src/services/document-processor.service.ts

declare global {
    namespace Express {
        namespace Multer {
            interface File {
                /** Field name specified in the form */
                fieldname: string;
                /** Name of the file on the user's computer */
                originalname: string;
                /** Encoding type of the file */
                encoding: string;
                /** Mime type of the file */
                mimetype: string;
                /** Size of the file in bytes */
                size: number;
                /** The folder to which the file has been saved (if configured) */
                destination: string;
                /** The name of the file within the destination (if configured) */
                filename: string;
                /** The full path to the uploaded file */
                path: string;
                /** A Buffer of the entire file (if configured) */
                buffer: Buffer;
            }
        }
    }
}

import fs from 'fs';
import csvParser from 'csv-parser';
import { Document, FileType } from '../models/document.model';
import { PDFParser } from '../utils/pdf-parser';
import { ExcelParser } from '../utils/excel-parser';
import { DocxParser } from '../utils/docx-parser';

interface CsvParseResult {
    data: Record<string, string>[];
    text: string;
    rowCount: number;
}

export class DocumentProcessorService {
    private pdfParser = new PDFParser();
    private excelParser = new ExcelParser();
    private docxParser = new DocxParser();

    public async process(file: Express.Multer.File): Promise<Document> {
        const document: Document = {
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
        } catch (error: any) {
            document.status = 'error';
            document.error = error?.message ?? 'Failed to process document';
        } finally {
            fs.unlink(file.path, () => {
                // ignore unlink errors
            });
        }

        return document;
    }

    private getFileType(filename: string): FileType {
        const extension = filename.split('.').pop()?.toLowerCase();
        if (!extension) throw new Error(`Unable to determine file type for ${filename}`);
        return extension as FileType;
    }

    private parseCSV(filepath: string): Promise<CsvParseResult> {
        return new Promise((resolve, reject) => {
            const rows: Record<string, string>[] = [];
            fs.createReadStream(filepath)
                .pipe(csvParser())
                .on('data', (row: any) => rows.push(row))
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

    private generateId(): string {
        return `doc_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }
}

export const documentProcessorService = new DocumentProcessorService();
