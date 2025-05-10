// src/firebase.ts
import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { CONFIG } from './config'; // Import the centralized config

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

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);