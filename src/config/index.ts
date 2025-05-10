// src/config/index.ts
export const CONFIG = {
    PORT: process.env.PORT || 3000,
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379', // Corrected protocol and added env var option
    OPEN_AI_API_KEY: process.env.OPEN_AI_API_KEY || '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',
    GROQ_API_KEY: process.env.GROQ_API_KEY ||'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',
    MODEL_NAME: process.env.MODEL_NAME || 'meta-llama/llama-4-scout-17b-16e-instruct',
    MAX_TOKENS: parseInt(process.env.MAX_TOKENS || '1000'),
    STREAM_CHUNK_SIZE: parseInt(process.env.STREAM_CHUNK_SIZE || '100'),
    TOOL_CONFIG_PATH: process.env.TOOL_CONFIG_PATH || './config/tool-config.json',
    NANGO_SECRET_KEY: process.env.NANGO_SECRET_KEY || '7addd614-fda8-48a2-9c79-5443fda50a84',
    PROVIDER_CONFIG_KEY: process.env.PROVIDER_CONFIG_KEY || 'salesforce-2',
    CONNECTION_ID: process.env.CONNECTION_ID || '42c5be6f-ffb9-4e99-9d77-daef88fe598f',
    nangoBaseUrl: process.env.nangoBaseUrl || 'https://api.nango.dev',
    
  };
  