// Lightweight LocalStorage-based session cache utilities for client apps.
// Mirror server-side shapes loosely; extend as needed in your client.

export type Message = {
  id?: string;
  role: 'user' | 'assistant';
  type: 'text' | 'interpretive' | string;
  content: any;
  timestamp?: string | Date;
};

export type InterpretiveResponse = any; // Keep flexible; align with server model if desired.

export type Session = {
  id: string;
  userId: string;
  title: string;
  createdAt?: string | Date;
  lastAccessedAt: string | Date;
  messages: Message[];
  lastInterpretiveResult?: InterpretiveResponse | null;
};

type SessionSummary = { id: string; title: string; lastAccessedAt: string | Date };

const keySession = (id: string) => `session:${id}`;
const keyUserSessions = (userId: string) => `sessions:byUser:${userId}`;

export function saveSession(sess: Session): void {
  localStorage.setItem(keySession(sess.id), JSON.stringify(sess));
}

export function getSession(id: string): Session | null {
  const raw = localStorage.getItem(keySession(id));
  return raw ? (JSON.parse(raw) as Session) : null;
}

export function listUserSessions(userId: string): SessionSummary[] {
  const raw = localStorage.getItem(keyUserSessions(userId));
  return raw ? (JSON.parse(raw) as SessionSummary[]) : [];
}

export function upsertUserSessionSummary(userId: string, sess: Session): void {
  const list = listUserSessions(userId);
  const next = list.filter((s) => s.id !== sess.id);
  next.unshift({ id: sess.id, title: sess.title, lastAccessedAt: sess.lastAccessedAt });
  localStorage.setItem(keyUserSessions(userId), JSON.stringify(next.slice(0, 100)));
}

export function appendMessage(sessionId: string, msg: Message): void {
  const sess = getSession(sessionId);
  if (!sess) return;
  const withTs: Message = { ...msg, timestamp: msg.timestamp ?? new Date().toISOString() };
  sess.messages.push(withTs);
  sess.lastAccessedAt = new Date().toISOString();
  saveSession(sess);
}

export function appendInterpretiveResult(sessionId: string, result: InterpretiveResponse): void {
  const sess = getSession(sessionId);
  if (!sess) return;
  sess.lastInterpretiveResult = result;
  sess.lastAccessedAt = new Date().toISOString();
  saveSession(sess);
}

export function replaceWithServerSnapshot(session: Session): void {
  // Overwrite local session with authoritative server state
  saveSession(session);
  upsertUserSessionSummary(session.userId, session);
}

export function removeSession(sessionId: string): void {
  localStorage.removeItem(keySession(sessionId));
}

// Streaming helpers (optional): manage a draft assistant message during SSE.
export function startAssistantDraft(sessionId: string, draftId: string = 'assistant-draft'): string {
  appendMessage(sessionId, { id: draftId, role: 'assistant', type: 'interpretive', content: '' });
  return draftId;
}

export function appendToDraft(sessionId: string, draftId: string, chunk: string): void {
  const sess = getSession(sessionId);
  if (!sess) return;
  const msg = sess.messages.find((m) => m.id === draftId);
  if (!msg) return;
  if (typeof msg.content !== 'string') msg.content = String(msg.content ?? '');
  msg.content += chunk;
  saveSession(sess);
}

export function finalizeDraftWithResult(
  sessionId: string,
  draftId: string,
  result: InterpretiveResponse,
): void {
  appendInterpretiveResult(sessionId, result);
  // Optionally keep the draft text as part of the final message content.
}

