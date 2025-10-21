"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const document_processor_service_1 = require("../services/document-processor.service");
const session_service_1 = require("../services/session.service");
const document_service_1 = require("../services/document.service");
const upload = (0, multer_1.default)({ dest: 'uploads/' });
const router = express_1.default.Router();
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const { sessionId, userId } = req.body;
        const file = req.file;
        if (!file) {
            res.status(400).json({ error: 'No file uploaded' });
            return;
        }
        const document = await document_processor_service_1.documentProcessorService.process(file);
        if (userId)
            document.userId = userId;
        if (sessionId)
            document.sessionId = sessionId;
        await document_service_1.documentService.save(document);
        if (sessionId) {
            await session_service_1.sessionService.addDocument(sessionId, document);
        }
        res.json(document);
    }
    catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to process document' });
    }
});
router.get('/:documentId/content', async (req, res) => {
    try {
        const document = await document_service_1.documentService.getDocument(req.params.documentId);
        if (!document) {
            res.status(404).json({ error: 'Document not found' });
            return;
        }
        res.json({
            id: document.id,
            content: document.processedContent,
            metadata: document.metadata,
        });
    }
    catch (error) {
        res.status(500).json({ error: error?.message ?? 'Failed to fetch document' });
    }
});
exports.default = router;
