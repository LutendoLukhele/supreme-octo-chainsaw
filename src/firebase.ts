// src/firebase.ts
import * as admin from 'firebase-admin'; // Import Firebase Admin SDK
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
// --- Add checks for new required env vars for Admin SDK cert ---

if (!CONFIG.FIREBASE_CLIENT_EMAIL) {
  logger.error("CRITICAL FIREBASE ADMIN CONFIG ERROR: FIREBASE_CLIENT_EMAIL is not defined (required for Admin SDK service account).");
  // Consider throwing an error if Firebase is absolutely essential
}
if (!CONFIG.FIREBASE_PRIVATE_KEY) {
  logger.error("CRITICAL FIREBASE ADMIN CONFIG ERROR: FIREBASE_PRIVATE_KEY is not defined (required for Admin SDK service account).");
  // Consider throwing an error if Firebase is absolutely essential
}

let app: admin.app.App;

// Check if Firebase Admin app has already been initialized
if (!admin.apps.length) {
  try {
    // Prepare service account credentials from CONFIG
    // Ensure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY are in your CONFIG
    const serviceAccount = {
      projectId: CONFIG.FIREBASE_PROJECT_ID,
      clientEmail: CONFIG.FIREBASE_CLIENT_EMAIL,
      // Replace escaped newlines in private key if stored as a single line in .env
      privateKey: CONFIG.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    };

    // Validate that the required fields for the cert are present
    if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
        const missingFields = [
            !serviceAccount.projectId && "projectId",
            !serviceAccount.clientEmail && "clientEmail",
            !serviceAccount.privateKey && "privateKey"
        ].filter(Boolean).join(", ");
        const errorMessage = `Firebase Admin SDK initialization failed: Missing required fields in service account configuration: ${missingFields}. Ensure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY are correctly set in your environment configuration.`;
        logger.error(errorMessage);
        throw new Error(errorMessage);
    }

    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount as admin.ServiceAccount), // Type assertion
      databaseURL: CONFIG.FIREBASE_DATABASE_URL
    });
    logger.info("Firebase Admin SDK initialized successfully.");
  } catch (error: any) {
    logger.error(`Firebase Admin SDK initialization failed: ${error.message}. Ensure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and FIREBASE_DATABASE_URL are correctly set in your environment configuration.`);
    // Re-throw the error to ensure the application doesn't proceed in a broken state
    throw error;
  }
} else {
  app = admin.app(); // Get the already initialized default app
  logger.info("Firebase Admin SDK already initialized. Using existing app.");
}

export const db = admin.database(app); // Get database instance from the specific app
export const auth = admin.auth(app);   // Export Firebase Admin Auth service from the specific app
export default admin; // Optionally export the entire admin namespace