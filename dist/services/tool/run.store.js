"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveRun = saveRun;
exports.getRun = getRun;
exports.clearRunStore = clearRunStore;
const runStore = {};
function saveRun(run) {
    runStore[run.id] = run;
}
function getRun(runId) {
    return runStore[runId];
}
function clearRunStore() {
    for (const key in runStore) {
        delete runStore[key];
    }
}
