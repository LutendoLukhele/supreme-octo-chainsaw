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
  const value = process.env[key]
    ?.trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .replace(/\\n/g, '\n');
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
  REDIS_URL: getEnvVar('REDIS_URL', undefined, true),
  OPEN_AI_API_KEY: getEnvVar('OPEN_AI_API_KEY', undefined, true),
  GROQ_API_KEY: getEnvVar('GROQ_API_KEY', undefined, true),
  CONNECTION_ID: getEnvVar('CONNECTION_ID', '2154ba8d-ce48-4a46-b4d3-295f1aa9e450'),
  MODEL_NAME: getEnvVar('MODEL_NAME', 'llama-3.3-70b-versatile'),
  MAX_TOKENS: parseInt(getEnvVar('MAX_TOKENS', '1000')),
  STREAM_CHUNK_SIZE: parseInt(getEnvVar('STREAM_CHUNK_SIZE', '100')),
  TOOL_CONFIG_PATH: getEnvVar('TOOL_CONFIG_PATH', './config/tool-config.json'),
  NANGO_SECRET_KEY: getEnvVar('NANGO_SECRET_KEY', '2065f150-7636-4592-8418-5affe59a5d94'),
  PROVIDER_CONFIG_KEY: getEnvVar('PROVIDER_CONFIG_KEY', 'salesforce-ybzg'),
  NANGO_BASE_URL: getEnvVar('NANGO_BASE_URL', 'https://api.nango.dev'),
  FIREBASE_API_KEY: getEnvVar('FIREBASE_API_KEY'),
  FIREBASE_AUTH_DOMAIN: getEnvVar('FIREBASE_AUTH_DOMAIN'),
  FIREBASE_PROJECT_ID: getEnvVar('FIREBASE_PROJECT_ID'),
  FIREBASE_STORAGE_BUCKET: getEnvVar('FIREBASE_STORAGE_BUCKET'),
  FIREBASE_MESSAGING_SENDER_ID: getEnvVar('FIREBASE_MESSAGING_SENDER_ID'),
  FIREBASE_APP_ID: getEnvVar('FIREBASE_APP_ID'),
  FIREBASE_PRIVATE_KEY: getEnvVar('FIREBASE_PRIVATE_KEY'),
  FIREBASE_CLIENT_EMAIL: getEnvVar('FIREBASE_CLIENT_EMAIL', 'lutendolukheles@gmail.com'),
  FIREBASE_MEASUREMENT_ID: getEnvVar('FIREBASE_MEASUREMENT_ID'),
  STRIPE_SECRET_KEY_TEST: getEnvVar('STRIPE_SECRET_KEY_TEST', undefined, false),
  STRIPE_SECRET_KEY_LIVE: getEnvVar('STRIPE_SECRET_KEY_LIVE', undefined, false),
  STRIPE_PRICE_ID: getEnvVar('STRIPE_PRICE_ID', undefined, false),
  STRIPE_WEBHOOK_SECRET: getEnvVar('STRIPE_WEBHOOK_SECRET', undefined, false),
  APP_SUCCESS_URL: getEnvVar('APP_SUCCESS_URL', 'https://yourapp.com/success', false),
  PUBLIC_API_BASE_URL: getEnvVar(
    'PUBLIC_API_BASE_URL',
    `http://localhost:${process.env.PORT || '8080'}`,
    false,
  ).replace(/\/+$/, ''),
  DATABASE_URL: getEnvVar('DATABASE_URL', undefined, true),
  NODE_ENV: nodeEnv,
  // RevenueCat secret for backend-to-backend API
  REVENUECAT_SECRET_KEY: getEnvVar('REVENUECAT_SECRET_KEY', undefined, false),
  REVENUCAT_API_KEY: getEnvVar('REVENUCAT_API_KEY', undefined, false),
};

console.log('[config/index.ts] Final CONFIG object (Firebase relevant parts):');
console.log(`[config/index.ts]   CONFIG.FIREBASE_PROJECT_ID: '${CONFIG.FIREBASE_PROJECT_ID}'`);
