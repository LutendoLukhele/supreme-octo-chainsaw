// src/routes/documents.ts

import express, { Request, Response } from 'express';
import multer from 'multer';
import { documentProcessorService } from '../services/document-processor.service';
import { sessionService } from '../services/session.service';
import { documentService } from '../services/document.service';

const upload = multer({ dest: 'uploads/' });
const router = express.Router();

router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
    try {
        const { sessionId, userId } = req.body as { sessionId?: string; userId?: string };
        const file = req.file;

        if (!file) {
            res.status(400).json({ error: 'No file uploaded' });
            return;
        }

        const document = await documentProcessorService.process(file);
        if (userId) document.userId = userId;
        if (sessionId) document.sessionId = sessionId;

        await documentService.save(document);

        if (sessionId) {
            await sessionService.addDocument(sessionId, document);
        }

        res.json(document);
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? 'Failed to process document' });
    }
});

router.get('/:documentId/content', async (req: Request, res: Response) => {
    try {
        const document = await documentService.getDocument(req.params.documentId);
        if (!document) {
            res.status(404).json({ error: 'Document not found' });
            return;
        }

        res.json({
            id: document.id,
            content: document.processedContent,
            metadata: document.metadata,
        });
    } catch (error: any) {
        res.status(500).json({ error: error?.message ?? 'Failed to fetch document' });
    }
});

export default router;
