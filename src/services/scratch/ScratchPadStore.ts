export interface ScratchEntry {
    source: string;
    filters: any;
    records: any[];
    summary: { count: number };
    timestamp: string;
  }
  
  export class ScratchPadStore {
    private store = new Map<string, Record<string, ScratchEntry>>();
    set(sessionId: string, key: string, entry: ScratchEntry) {
      const sess = this.store.get(sessionId) || {};
      sess[key] = entry;
      this.store.set(sessionId, sess);
    }
    get(sessionId: string): Record<string, ScratchEntry> {
      return this.store.get(sessionId) || {};
    }
    clearSession(sessionId: string): void {
      this.store.delete(sessionId);
    }
  }
  