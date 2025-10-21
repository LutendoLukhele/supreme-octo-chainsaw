// src/utils/excel-parser.ts

import XLSX from 'xlsx';

export interface ExcelResult {
    text: string;
    sheets: Record<string, unknown[][]>;
    sheetCount: number;
    tableCount: number;
}

export class ExcelParser {
    public async parse(filepath: string): Promise<ExcelResult> {
        const workbook = XLSX.readFile(filepath);
        const sheets: Record<string, unknown[][]> = {};
        let combinedText = '';
        let tableCount = 0;

        workbook.SheetNames.forEach((sheetName: any) => {
            const worksheet = workbook.Sheets[sheetName];
            const sheetData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as unknown[][];
            sheets[sheetName] = sheetData;
            tableCount += 1;

            sheetData.forEach((row: any) => {
                combinedText += `${row.join(', ')}
`;
            });
        });

        return {
            text: combinedText,
            sheets,
            sheetCount: workbook.SheetNames.length,
            tableCount,
        };
    }
}