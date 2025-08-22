"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auth = exports.db = void 0;
const admin = __importStar(require("firebase-admin"));
const config_1 = require("./config");
const winston_1 = __importDefault(require("winston"));
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.simple(),
    transports: [new winston_1.default.transports.Console()],
});
if (!config_1.CONFIG.FIREBASE_PROJECT_ID) {
    logger.error("CRITICAL FIREBASE CONFIG ERROR: FIREBASE_PROJECT_ID is not defined. Firebase cannot initialize properly.");
}
if (!config_1.CONFIG.FIREBASE_DATABASE_URL) {
    logger.error("CRITICAL FIREBASE CONFIG ERROR: FIREBASE_DATABASE_URL is not defined. Firebase Realtime Database cannot be determined.");
}
if (!config_1.CONFIG.FIREBASE_CLIENT_EMAIL) {
    logger.error("CRITICAL FIREBASE ADMIN CONFIG ERROR: FIREBASE_CLIENT_EMAIL is not defined (required for Admin SDK service account).");
}
if (!config_1.CONFIG.FIREBASE_PRIVATE_KEY) {
    logger.error("CRITICAL FIREBASE ADMIN CONFIG ERROR: FIREBASE_PRIVATE_KEY is not defined (required for Admin SDK service account).");
}
let app;
if (!admin.apps.length) {
    try {
        const serviceAccount = {
            projectId: config_1.CONFIG.FIREBASE_PROJECT_ID,
            clientEmail: config_1.CONFIG.FIREBASE_CLIENT_EMAIL,
            privateKey: config_1.CONFIG.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        };
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
            credential: admin.credential.cert(serviceAccount),
            databaseURL: config_1.CONFIG.FIREBASE_DATABASE_URL
        });
        logger.info("Firebase Admin SDK initialized successfully.");
    }
    catch (error) {
        logger.error(`Firebase Admin SDK initialization failed: ${error.message}. Ensure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and FIREBASE_DATABASE_URL are correctly set in your environment configuration.`);
        throw error;
    }
}
else {
    app = admin.app();
    logger.info("Firebase Admin SDK already initialized. Using existing app.");
}
exports.db = admin.database(app);
exports.auth = admin.auth(app);
exports.default = admin;
