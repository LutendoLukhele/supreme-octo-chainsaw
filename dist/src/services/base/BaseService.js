"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseService = void 0;
class BaseService {
    logger;
    constructor(config) {
        this.logger = config.logger;
    }
}
exports.BaseService = BaseService;
