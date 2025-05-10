// src/services/base/BaseService.ts
import { ServiceConfig, Logger } from './/types';

export abstract class BaseService {
  protected logger: Logger;
  
  constructor(config: ServiceConfig) {
    this.logger = config.logger;
  }
}
