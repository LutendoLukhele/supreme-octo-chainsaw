// src/firebase.ts
import * as admin from 'firebase-admin'; // Import Firebase Admin SDK
import { CONFIG } from './config';       // Import the centralized config
import winston from 'winston';           // For logging

// Basic logger for this module
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [new winston.transports.Console()],
});


// --- 1. Centralized Configuration Validation ---
// We check all required variables at the start. If any are missing, the app will throw an error and stop.
if (!CONFIG.FIREBASE_PROJECT_ID || !CONFIG.FIREBASE_CLIENT_EMAIL || !CONFIG.FIREBASE_PRIVATE_KEY) {
  const missingVars = [
    !CONFIG.FIREBASE_PROJECT_ID && "FIREBASE_PROJECT_ID",
    !CONFIG.FIREBASE_CLIENT_EMAIL && "FIREBASE_CLIENT_EMAIL",
    !CONFIG.FIREBASE_PRIVATE_KEY && "FIREBASE_PRIVATE_KEY"
  ].filter(Boolean).join(', ');

  const errorMessage = `CRITICAL FIREBASE CONFIG ERROR: The following environment variables are missing: ${missingVars}. The application cannot start.`;
  logger.error(errorMessage);
  throw new Error(errorMessage);
}


// --- 2. Firebase Initialization ---
let app: admin.app.App;

// This logic now runs correctly AFTER the configuration has been validated.
if (!admin.apps.length) {
  try {
    // Prepare service account credentials from the validated CONFIG
    const serviceAccount = {
      projectId: CONFIG.FIREBASE_PROJECT_ID,
      clientEmail: CONFIG.FIREBASE_CLIENT_EMAIL,
      // Replace escaped newlines in private key, which is common for environment variables
      privateKey: CONFIG.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };

    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
    });
    logger.info("Firebase Admin SDK initialized successfully.");

  } catch (error: any) {
    logger.error(`Firebase Admin SDK initialization failed: ${error.message}`);
    // Re-throw the error to ensure the application doesn't proceed in a broken state
    throw error;
  }
} else {
  app = admin.app(); // Get the already initialized default app
  logger.info("Firebase Admin SDK already initialized. Using existing app.");
}


// --- 3. Exports ---
// These are now in the correct scope and will work as intended.
export const auth = admin.auth(app); // Export Firebase Admin Auth service from the specific app
export default admin;