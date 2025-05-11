"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG = void 0;
// src/config/index.ts
exports.CONFIG = {
    PORT: process.env.PORT || 3000,
    GROQ_API_KEY: process.env.GROQ_API_KEY || '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',
    MODEL_NAME: process.env.MODEL_NAME || 'llama-3.3-70b-versatile',
    MAX_TOKENS: parseInt(process.env.MAX_TOKENS || '1000'),
    STREAM_CHUNK_SIZE: parseInt(process.env.STREAM_CHUNK_SIZE || '100'),
    TOOL_CONFIG_PATH: process.env.TOOL_CONFIG_PATH || './tool-config.json',
    NANGO_SECRET_KEY: process.env.NANGO_SECRET_KEY || '7addd614-fda8-48a2-9c79-5443fda50a84',
    PROVIDER_CONFIG_KEY: process.env.PROVIDER_CONFIG_KEY || 'salesforce-2',
    CONNECTION_ID: process.env.CONNECTION_ID || '2afdea8f-9c5a-4555-9e88-6c440e59c037',
    nangoBaseUrl: process.env.nangoBaseUrl || 'https://api.nango.dev',
};
