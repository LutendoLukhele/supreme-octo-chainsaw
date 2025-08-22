"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const nodeEnv = process.env.NODE_ENV || 'development';
console.log(`[config/index.ts] Starting configuration loading. NODE_ENV: ${nodeEnv}`);
console.log(`[config/index.ts] Current working directory (process.cwd()): ${process.cwd()}`);
const projectRootEnvPath = path_1.default.resolve(__dirname, '../../.env');
const dotenvResult = dotenv_1.default.config({ path: projectRootEnvPath });
if (dotenvResult.error) {
    console.error(`[config/index.ts] Error loading .env file from ${projectRootEnvPath}: ${dotenvResult.error.message}`);
    if (nodeEnv !== 'development') {
        console.warn('[config/index.ts] In non-development environments, ensure environment variables are set directly (e.g., in Cloud Run).');
    }
}
else if (dotenvResult.parsed && Object.keys(dotenvResult.parsed).length > 0) {
    console.log(`[config/index.ts] .env file loaded successfully from ${projectRootEnvPath}.`);
}
else {
    console.warn(`[config/index.ts] .env file not found at ${projectRootEnvPath}, was empty, or all variables might already be set in the environment.`);
}
const getEnvVar = (key, defaultValue, isCritical = false) => {
    const value = process.env[key];
    if (value === undefined || value === '') {
        if (defaultValue !== undefined) {
            console.warn(`[config/index.ts] Environment variable ${key} is not set or empty, using default value: '${defaultValue}'`);
            return defaultValue;
        }
        if (isCritical) {
            const errorMessage = `[config/index.ts] CRITICAL ERROR: Environment variable ${key} is missing or empty and has no default. This is required.`;
            console.error(errorMessage);
            throw new Error(errorMessage);
        }
        console.warn(`[config/index.ts] Environment variable ${key} is not set or empty, no default provided. Will return empty string.`);
        return '';
    }
    return value;
};
exports.CONFIG = {
    REDIS_URL: getEnvVar('REDIS_URL', 'redis://default:ewgkpSkF91VxHqMdZJ5mqHRpqaOut6jB@redis-15785.c276.us-east-1-2.ec2.redns.redis-cloud.com:15785'),
    OPEN_AI_API_KEY: getEnvVar('OPEN_AI_API_KEY', undefined, true),
    GROQ_API_KEY: getEnvVar('GROQ_API_KEY', undefined, true),
    CONNECTION_ID: getEnvVar('CONNECTION_ID', '2154ba8d-ce48-4a46-b4d3-295f1aa9e450'),
    MODEL_NAME: getEnvVar('MODEL_NAME', 'llama-3.3-70b-versatile'),
    MAX_TOKENS: parseInt(getEnvVar('MAX_TOKENS', '1000')),
    STREAM_CHUNK_SIZE: parseInt(getEnvVar('STREAM_CHUNK_SIZE', '100')),
    TOOL_CONFIG_PATH: getEnvVar('TOOL_CONFIG_PATH', './config/tool-config.json'),
    NANGO_SECRET_KEY: getEnvVar('NANGO_SECRET_KEY', '2065f150-7636-4592-8418-5affe59a5d94'),
    PROVIDER_CONFIG_KEY: getEnvVar('PROVIDER_CONFIG_KEY', 'salesforce-2'),
    NANGO_BASE_URL: getEnvVar('NANGO_BASE_URL', 'https://api.nango.dev'),
    FIREBASE_API_KEY: getEnvVar('FIREBASE_API_KEY'),
    FIREBASE_AUTH_DOMAIN: getEnvVar('FIREBASE_AUTH_DOMAIN'),
    FIREBASE_DATABASE_URL: getEnvVar('FIREBASE_DATABASE_URL', undefined, true),
    FIREBASE_PROJECT_ID: getEnvVar('FIREBASE_PROJECT_ID', undefined, true),
    FIREBASE_STORAGE_BUCKET: getEnvVar('FIREBASE_STORAGE_BUCKET'),
    FIREBASE_MESSAGING_SENDER_ID: getEnvVar('FIREBASE_MESSAGING_SENDER_ID'),
    FIREBASE_APP_ID: getEnvVar('FIREBASE_APP_ID'),
    FIREBASE_PRIVATE_KEY: getEnvVar('FIREBASE_PRIVATE_KEY'),
    FIREBASE_CLIENT_EMAIL: getEnvVar('FIREBASE_CLIENT_EMAIL', 'lutendolukheles@gmail.com'),
    FIREBASE_MEASUREMENT_ID: getEnvVar('FIREBASE_MEASUREMENT_ID'),
    NODE_ENV: nodeEnv,
};
console.log('[config/index.ts] Final CONFIG object (Firebase relevant parts):');
console.log(`[config/index.ts]   CONFIG.FIREBASE_PROJECT_ID: '${exports.CONFIG.FIREBASE_PROJECT_ID}'`);
console.log(`[config/index.ts]   CONFIG.FIREBASE_DATABASE_URL: '${exports.CONFIG.FIREBASE_DATABASE_URL}'`);
if (!exports.CONFIG.FIREBASE_PROJECT_ID || !exports.CONFIG.FIREBASE_DATABASE_URL) {
    console.error("[config/index.ts] POST-CONFIG CHECK: CRITICAL - FIREBASE_PROJECT_ID or FIREBASE_DATABASE_URL is missing or empty in the final CONFIG object. Firebase initialization will likely fail.");
}
