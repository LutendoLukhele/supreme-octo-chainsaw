// src/firebase.ts
import { initializeApp, getApps, getApp } from 'firebase/app'; // Import getApps and getApp
import { getDatabase } from 'firebase/database';
import { CONFIG } from './config'; // Import the centralized config
import winston from 'winston'; // For logging

// Basic logger for this module, can be enhanced
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.simple(),
    transports: [new winston.transports.Console()],
});

// --- Critical Firebase Config Validation ---
if (!CONFIG.FIREBASE_PROJECT_ID) {
  logger.error("CRITICAL FIREBASE CONFIG ERROR: FIREBASE_PROJECT_ID is not defined. Firebase cannot initialize properly.");
  // Consider throwing an error if Firebase is absolutely essential for app startup
  // throw new Error("CRITICAL FIREBASE CONFIG ERROR: FIREBASE_PROJECT_ID is not defined.");
}
if (!CONFIG.FIREBASE_DATABASE_URL) {
  logger.error("CRITICAL FIREBASE CONFIG ERROR: FIREBASE_DATABASE_URL is not defined. Firebase Realtime Database cannot be determined.");
  // throw new Error("CRITICAL FIREBASE CONFIG ERROR: FIREBASE_DATABASE_URL is not defined.");
}

const firebaseConfig = {
    apiKey: CONFIG.FIREBASE_API_KEY,
    authDomain: CONFIG.FIREBASE_AUTH_DOMAIN,
    databaseURL: CONFIG.FIREBASE_DATABASE_URL,
    projectId: CONFIG.FIREBASE_PROJECT_ID,
    storageBucket: CONFIG.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: CONFIG.FIREBASE_MESSAGING_SENDER_ID,
    appId: CONFIG.FIREBASE_APP_ID,
    measurementId: CONFIG.FIREBASE_MEASUREMENT_ID
  };

let app;
// Check if Firebase app has already been initialized to prevent re-initialization errors
if (!getApps().length) {
  try {
    app = initializeApp(firebaseConfig);
    logger.info("Firebase app initialized successfully.");
  } catch (error: any) {
    logger.error(`Firebase initialization failed: ${error.message}. Ensure all firebaseConfig values (especially projectId and databaseURL) are correctly set in your Cloud Run environment configuration.`);
    // Re-throw the error to ensure the application doesn't proceed in a broken state
    // if Firebase is essential.
    throw error;
  }
} else {
  app = getApp(); // Get the already initialized app
  logger.info("Firebase app already initialized. Using existing app.");
}

export const db = getDatabase(app);