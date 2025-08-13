"use strict";
// src/services/tool/run.store.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveRun = saveRun;
exports.getRun = getRun;
exports.clearRunStore = clearRunStore;
/**
 * A simple in-memory store for Run objects.
 * The key is the runId.
 * In a production environment, this would be replaced with a persistent store like Redis, Firestore, or a SQL database.
 */
const runStore = {};
/**
 * Saves or updates a Run object in the store.
 * @param run The Run object to save.
 */
function saveRun(run) {
    runStore[run.id] = run;
}
/**
 * Retrieves a Run object from the store by its ID.
 * @param runId The ID of the run to retrieve.
 * @returns The Run object, or undefined if not found.
 */
function getRun(runId) {
    return runStore[runId];
}
/**
 * (Optional) A utility function to clear the store, useful for testing.
 */
function clearRunStore() {
    for (const key in runStore) {
        delete runStore[key];
    }
}
