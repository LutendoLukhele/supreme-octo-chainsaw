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
exports.auth = void 0;
const admin = __importStar(require("firebase-admin"));
const config_1 = require("./config");
const winston_1 = __importDefault(require("winston"));
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.simple(),
    transports: [new winston_1.default.transports.Console()],
});
if (!config_1.CONFIG.FIREBASE_PROJECT_ID || !config_1.CONFIG.FIREBASE_CLIENT_EMAIL || !config_1.CONFIG.FIREBASE_PRIVATE_KEY) {
    const missingVars = [
        !config_1.CONFIG.FIREBASE_PROJECT_ID && "FIREBASE_PROJECT_ID",
        !config_1.CONFIG.FIREBASE_CLIENT_EMAIL && "FIREBASE_CLIENT_EMAIL",
        !config_1.CONFIG.FIREBASE_PRIVATE_KEY && "FIREBASE_PRIVATE_KEY"
    ].filter(Boolean).join(', ');
    const errorMessage = `CRITICAL FIREBASE CONFIG ERROR: The following environment variables are missing: ${missingVars}. The application cannot start.`;
    logger.error(errorMessage);
    throw new Error(errorMessage);
}
let app;
if (!admin.apps.length) {
    try {
        const serviceAccount = {
            projectId: config_1.CONFIG.FIREBASE_PROJECT_ID,
            clientEmail: config_1.CONFIG.FIREBASE_CLIENT_EMAIL,
            privateKey: config_1.CONFIG.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        };
        app = admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        logger.info("Firebase Admin SDK initialized successfully.");
    }
    catch (error) {
        logger.error(`Firebase Admin SDK initialization failed: ${error.message}`);
        throw error;
    }
}
else {
    app = admin.app();
    logger.info("Firebase Admin SDK already initialized. Using existing app.");
}
exports.auth = admin.auth(app);
exports.default = admin;
