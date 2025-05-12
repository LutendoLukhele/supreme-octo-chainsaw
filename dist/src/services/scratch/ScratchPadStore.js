"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScratchPadStore = void 0;
class ScratchPadStore {
    store = new Map();
    set(sessionId, key, entry) {
        const sess = this.store.get(sessionId) || {};
        sess[key] = entry;
        this.store.set(sessionId, sess);
    }
    get(sessionId) {
        return this.store.get(sessionId) || {};
    }
    clearSession(sessionId) {
        this.store.delete(sessionId);
    }
}
exports.ScratchPadStore = ScratchPadStore;
