"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExcelParser = void 0;
const xlsx_1 = __importDefault(require("xlsx"));
class ExcelParser {
    async parse(filepath) {
        const workbook = xlsx_1.default.readFile(filepath);
        const sheets = {};
        let combinedText = '';
        let tableCount = 0;
        workbook.SheetNames.forEach((sheetName) => {
            const worksheet = workbook.Sheets[sheetName];
            const sheetData = xlsx_1.default.utils.sheet_to_json(worksheet, { header: 1 });
            sheets[sheetName] = sheetData;
            tableCount += 1;
            sheetData.forEach((row) => {
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
exports.ExcelParser = ExcelParser;
