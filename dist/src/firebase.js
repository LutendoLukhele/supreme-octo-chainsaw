"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
// src/firebase.ts
const app_1 = require("firebase/app"); // Import getApps and getApp
const database_1 = require("firebase/database");
const config_1 = require("./config"); // Import the centralized config
const winston_1 = __importDefault(require("winston")); // For logging
// Basic logger for this module, can be enhanced
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.simple(),
    transports: [new winston_1.default.transports.Console()],
});
// --- Critical Firebase Config Validation ---
if (!config_1.CONFIG.FIREBASE_PROJECT_ID) {
    logger.error("CRITICAL FIREBASE CONFIG ERROR: FIREBASE_PROJECT_ID is not defined. Firebase cannot initialize properly.");
    // Consider throwing an error if Firebase is absolutely essential for app startup
    // throw new Error("CRITICAL FIREBASE CONFIG ERROR: FIREBASE_PROJECT_ID is not defined.");
}
if (!config_1.CONFIG.FIREBASE_DATABASE_URL) {
    logger.error("CRITICAL FIREBASE CONFIG ERROR: FIREBASE_DATABASE_URL is not defined. Firebase Realtime Database cannot be determined.");
    // throw new Error("CRITICAL FIREBASE CONFIG ERROR: FIREBASE_DATABASE_URL is not defined.");
}
const firebaseConfig = {
    apiKey: config_1.CONFIG.FIREBASE_API_KEY,
    authDomain: config_1.CONFIG.FIREBASE_AUTH_DOMAIN,
    databaseURL: config_1.CONFIG.FIREBASE_DATABASE_URL,
    projectId: config_1.CONFIG.FIREBASE_PROJECT_ID,
    storageBucket: config_1.CONFIG.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: config_1.CONFIG.FIREBASE_MESSAGING_SENDER_ID,
    appId: config_1.CONFIG.FIREBASE_APP_ID,
    measurementId: config_1.CONFIG.FIREBASE_MEASUREMENT_ID
};
let app;
// Check if Firebase app has already been initialized to prevent re-initialization errors
if (!(0, app_1.getApps)().length) {
    try {
        app = (0, app_1.initializeApp)(firebaseConfig);
        logger.info("Firebase app initialized successfully.");
    }
    catch (error) {
        logger.error(`Firebase initialization failed: ${error.message}. Ensure all firebaseConfig values (especially projectId and databaseURL) are correctly set in your Cloud Run environment configuration.`);
        // Re-throw the error to ensure the application doesn't proceed in a broken state
        // if Firebase is essential.
        throw error;
    }
}
else {
    app = (0, app_1.getApp)(); // Get the already initialized app
    logger.info("Firebase app already initialized. Using existing app.");
}
exports.db = (0, database_1.getDatabase)(app);
