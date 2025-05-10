// src/firebase.ts
import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
    apiKey: "AIzaSyCWAXud14gWvvTKP5_oDRaNLIIrH5Z0hgo",
    authDomain: "assistant-b00f5.firebaseapp.com",
    databaseURL: "https://assistant-b00f5-default-rtdb.firebaseio.com",
    projectId: "assistant-b00f5",
    storageBucket: "assistant-b00f5.firebasestorage.app",
    messagingSenderId: "876200943144",
    appId: "1:876200943144:web:bca0933dd3bd71e9605f1d",
    measurementId: "G-H108B15KW3"
  };

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);