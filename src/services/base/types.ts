// src/services/base/types.ts
export interface ServiceConfig {
    logger: Logger;
  }
  
  export interface Logger {
    info: (message: string, meta?: any) => void;
    error: (message: string, meta?: any) => void;
    debug: (message: string, meta?: any) => void;
    warn: (message: string, meta?: any) => void;
  }