// src/config/index.ts
export const CONFIG = {
    PORT: process.env.PORT || 3000,
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379', // Corrected protocol and added env var option
    OPEN_AI_API_KEY: process.env.OPEN_AI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    MODEL_NAME: process.env.MODEL_NAME || 'meta-llama/llama-4-scout-17b-16e-instruct',
    MAX_TOKENS: parseInt(process.env.MAX_TOKENS || '1000'),
    STREAM_CHUNK_SIZE: parseInt(process.env.STREAM_CHUNK_SIZE || '100'),
    TOOL_CONFIG_PATH: process.env.TOOL_CONFIG_PATH || './config/tool-config.json',
    NANGO_SECRET_KEY: process.env.NANGO_SECRET_KEY,
    PROVIDER_CONFIG_KEY: process.env.PROVIDER_CONFIG_KEY || 'salesforce-2',
    // CONNECTION_ID is user-specific and should not be a global config. It will be fetched dynamically.
    NANGO_BASE_URL: process.env.NANGO_BASE_URL || 'https://api.nango.dev', // Standardized from nangoBaseUrl
    FIREBASE_API_KEY: process.env.FIREBASE_API_KEY,
    FIREBASE_AUTH_DOMAIN: process.env.FIREBASE_AUTH_DOMAIN,
    FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET,
    FIREBASE_MESSAGING_SENDER_ID: process.env.FIREBASE_MESSAGING_SENDER_ID,
    FIREBASE_APP_ID: process.env.FIREBASE_APP_ID,
    FIREBASE_MEASUREMENT_ID: process.env.FIREBASE_MEASUREMENT_ID,
  };