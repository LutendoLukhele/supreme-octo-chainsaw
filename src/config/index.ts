// src/config/index.ts
import dotenv from 'dotenv';
import path from 'path';

// Determine the environment
const nodeEnv = process.env.NODE_ENV || 'development';

console.log(`[config/index.ts] Starting configuration loading. NODE_ENV: ${nodeEnv}`);
console.log(`[config/index.ts] Current working directory (process.cwd()): ${process.cwd()}`);

// Load the .env file from the project root
// __dirname will be /Users/lutendolukhele/Desktop/backedn-main/src/config
// So, to get to the project root, we go up two levels.
const projectRootEnvPath = path.resolve(__dirname, '../../.env');
const dotenvResult = dotenv.config({ path: projectRootEnvPath });

if (dotenvResult.error) {
  console.error(`[config/index.ts] Error loading .env file from ${projectRootEnvPath}: ${dotenvResult.error.message}`);
  if (nodeEnv !== 'development') {
    console.warn('[config/index.ts] In non-development environments, ensure environment variables are set directly (e.g., in Cloud Run).');
  }
} else if (dotenvResult.parsed && Object.keys(dotenvResult.parsed).length > 0) {
  console.log(`[config/index.ts] .env file loaded successfully from ${projectRootEnvPath}.`);
  // console.log('[config/index.ts] Keys parsed from .env file:', Object.keys(dotenvResult.parsed).join(', '));
} else {
  console.warn(`[config/index.ts] .env file not found at ${projectRootEnvPath}, was empty, or all variables might already be set in the environment.`);
}

// Helper function to get environment variables with defaults and critical checks
const getEnvVar = (key: string, defaultValue?: string, isCritical: boolean = false): string => {
  const value = process.env[key];
  // console.log(`[config/index.ts] getEnvVar: Reading process.env.${key} - Value: '${value}'`);
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) {
      console.warn(`[config/index.ts] Environment variable ${key} is not set or empty, using default value: '${defaultValue}'`);
      return defaultValue;
    }
    if (isCritical) {
      const errorMessage = `[config/index.ts] CRITICAL ERROR: Environment variable ${key} is missing or empty and has no default. This is required.`;
      console.error(errorMessage);
      throw new Error(errorMessage); // Stop the application if critical config is missing
    }
    console.warn(`[config/index.ts] Environment variable ${key} is not set or empty, no default provided. Will return empty string.`);
    return ''; // Or handle as undefined if preferred
  }
  return value;
};

export const CONFIG = {
  
    REDIS_URL: getEnvVar('REDIS_URL', 'redis://default:ewgkpSkF91VxHqMdZJ5mqHRpqaOut6jB@redis-15785.c276.us-east-1-2.ec2.redns.redis-cloud.com:15785'),
    OPEN_AI_API_KEY: getEnvVar('OPEN_AI_API_KEY', undefined, true), // Mark as critical
    GROQ_API_KEY: getEnvVar('GROQ_API_KEY', undefined, true),       // Mark as critical
    CONNECTION_ID: getEnvVar('CONNECTION_ID', '2154ba8d-ce48-4a46-b4d3-295f1aa9e450'), // User-specific, might not always be in .env
    MODEL_NAME: getEnvVar('MODEL_NAME', 'openai/gpt-oss-20b'),
    MAX_TOKENS: parseInt(getEnvVar('MAX_TOKENS', '1000')),
    STREAM_CHUNK_SIZE: parseInt(getEnvVar('STREAM_CHUNK_SIZE', '100')),
    TOOL_CONFIG_PATH: getEnvVar('TOOL_CONFIG_PATH', './config/tool-config.json'),
    NANGO_SECRET_KEY: getEnvVar('NANGO_SECRET_KEY', '2065f150-7636-4592-8418-5affe59a5d94'), // Potentially critical depending on usage
    PROVIDER_CONFIG_KEY: getEnvVar('PROVIDER_CONFIG_KEY', 'salesforce-2'),
    // CONNECTION_ID is user-specific and should not be a global config. It will be fetched dynamically.
    NANGO_BASE_URL: getEnvVar('NANGO_BASE_URL', 'https://api.nango.dev'),
    FIREBASE_API_KEY: getEnvVar('FIREBASE_API_KEY'), // Often needed
    FIREBASE_AUTH_DOMAIN: getEnvVar('FIREBASE_AUTH_DOMAIN'),
    FIREBASE_PROJECT_ID: getEnvVar('FIREBASE_PROJECT_ID'),     // Critical for Firebase
    FIREBASE_STORAGE_BUCKET: getEnvVar('FIREBASE_STORAGE_BUCKET'),
    FIREBASE_MESSAGING_SENDER_ID: getEnvVar('FIREBASE_MESSAGING_SENDER_ID'),
    FIREBASE_APP_ID: getEnvVar('FIREBASE_APP_ID'),
    FIREBASE_PRIVATE_KEY: getEnvVar('FIREBASE_PRIVATE_KEY'),
    FIREBASE_CLIENT_EMAIL: getEnvVar('FIREBASE_CLIENT_EMAIL', 'lutendolukheles@gmail.com'),
    FIREBASE_MEASUREMENT_ID: getEnvVar('FIREBASE_MEASUREMENT_ID'), // Optional
    NODE_ENV: nodeEnv, // Add NODE_ENV to CONFIG as well
  };

console.log('[config/index.ts] Final CONFIG object (Firebase relevant parts):');
console.log(`[config/index.ts]   CONFIG.FIREBASE_PROJECT_ID: '${CONFIG.FIREBASE_PROJECT_ID}'`);
