"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveSession = saveSession;
exports.getSession = getSession;
exports.listUserSessions = listUserSessions;
exports.upsertUserSessionSummary = upsertUserSessionSummary;
exports.appendMessage = appendMessage;
exports.appendInterpretiveResult = appendInterpretiveResult;
exports.replaceWithServerSnapshot = replaceWithServerSnapshot;
exports.removeSession = removeSession;
exports.startAssistantDraft = startAssistantDraft;
exports.appendToDraft = appendToDraft;
exports.finalizeDraftWithResult = finalizeDraftWithResult;
const keySession = (id) => `session:${id}`;
const keyUserSessions = (userId) => `sessions:byUser:${userId}`;
function saveSession(sess) {
    localStorage.setItem(keySession(sess.id), JSON.stringify(sess));
}
function getSession(id) {
    const raw = localStorage.getItem(keySession(id));
    return raw ? JSON.parse(raw) : null;
}
function listUserSessions(userId) {
    const raw = localStorage.getItem(keyUserSessions(userId));
    return raw ? JSON.parse(raw) : [];
}
function upsertUserSessionSummary(userId, sess) {
    const list = listUserSessions(userId);
    const next = list.filter((s) => s.id !== sess.id);
    next.unshift({ id: sess.id, title: sess.title, lastAccessedAt: sess.lastAccessedAt });
    localStorage.setItem(keyUserSessions(userId), JSON.stringify(next.slice(0, 100)));
}
function appendMessage(sessionId, msg) {
    const sess = getSession(sessionId);
    if (!sess)
        return;
    const withTs = { ...msg, timestamp: msg.timestamp ?? new Date().toISOString() };
    sess.messages.push(withTs);
    sess.lastAccessedAt = new Date().toISOString();
    saveSession(sess);
}
function appendInterpretiveResult(sessionId, result) {
    const sess = getSession(sessionId);
    if (!sess)
        return;
    sess.lastInterpretiveResult = result;
    sess.lastAccessedAt = new Date().toISOString();
    saveSession(sess);
}
function replaceWithServerSnapshot(session) {
    saveSession(session);
    upsertUserSessionSummary(session.userId, session);
}
function removeSession(sessionId) {
    localStorage.removeItem(keySession(sessionId));
}
function startAssistantDraft(sessionId, draftId = 'assistant-draft') {
    appendMessage(sessionId, { id: draftId, role: 'assistant', type: 'interpretive', content: '' });
    return draftId;
}
function appendToDraft(sessionId, draftId, chunk) {
    const sess = getSession(sessionId);
    if (!sess)
        return;
    const msg = sess.messages.find((m) => m.id === draftId);
    if (!msg)
        return;
    if (typeof msg.content !== 'string')
        msg.content = String(msg.content ?? '');
    msg.content += chunk;
    saveSession(sess);
}
function finalizeDraftWithResult(sessionId, draftId, result) {
    appendInterpretiveResult(sessionId, result);
}
