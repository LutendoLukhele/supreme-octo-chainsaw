// src/services/tool/run.store.ts

import { Run } from '../tool/run.types';

/**
 * A simple in-memory store for Run objects.
 * The key is the runId.
 * In a production environment, this would be replaced with a persistent store like Redis, Firestore, or a SQL database.
 */
const runStore: Record<string, Run> = {};

/**
 * Saves or updates a Run object in the store.
 * @param run The Run object to save.
 */
export function saveRun(run: Run): void {
  runStore[run.id] = run;
}

/**
 * Retrieves a Run object from the store by its ID.
 * @param runId The ID of the run to retrieve.
 * @returns The Run object, or undefined if not found.
 */
export function getRun(runId: string): Run | undefined {
  return runStore[runId];
}

/**
 * (Optional) A utility function to clear the store, useful for testing.
 */
export function clearRunStore(): void {
  for (const key in runStore) {
    delete runStore[key];
  }
}
