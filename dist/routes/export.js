"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const export_service_1 = require("../services/export.service");
const router = express_1.default.Router();
router.post('/:destination', async (req, res) => {
    try {
        const destination = req.params.destination;
        const { content, format, userId, config } = req.body;
        if (!content || !userId) {
            res.status(400).json({ error: 'content and userId are required' });
            return;
        }
        const result = await export_service_1.exportService.export(content, destination, format ?? 'markdown', userId, (config ?? {}));
        res.json(result);
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error?.message ?? 'Export failed',
            message: 'Export failed',
            timestamp: new Date().toISOString(),
        });
    }
});
exports.default = router;
