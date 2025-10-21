**Client Persistence (LocalStorage)**
- Goal: keep sessions, chats, and interpret results on the client using LocalStorage. Works with existing endpoints in `src/routes/sessions.ts` and `src/routes/interpret.ts`.

**Storage Keys**
- `session:<sessionId>`: full Session JSON.
- `sessions:byUser:<userId>`: array of `{ id, title, lastAccessedAt }` summaries for quick listing.

**Session Shape**
- Mirror server types from `src/models/session.model.ts` and `src/models/interpretive.model.ts`.
- Minimum fields used by this doc: `id`, `userId`, `title`, `lastAccessedAt`, `messages[]`, `lastInterpretiveResult`.

**API Calls**
- Create: `POST /sessions` `{ userId, initialQuery? }` → Session
- Get by id: `GET /sessions/:sessionId` → Session
- Get by user: `GET /sessions/user/:userId` → Session[]
- Add message: `POST /sessions/:sessionId/messages` `{ role, type, content }` → Session
- Interpret: `POST /interpret` `{ query, sessionId, ... }` → InterpretiveResponse (or use SSE with `stream=true`)

**Client Helpers (LocalStorage)**
- Use the following as a drop-in utility. Adjust types to your app.

```
// sessionCache.ts (client)
type Message = { id?: string; role: 'user'|'assistant'; type: 'text'|'interpretive'|string; content: any; timestamp?: string|Date };
type InterpretiveResponse = any; // match server
type Session = {
  id: string;
  userId: string;
  title: string;
  createdAt?: string|Date;
  lastAccessedAt: string|Date;
  messages: Message[];
  lastInterpretiveResult?: InterpretiveResponse|null;
};

const keySession = (id: string) => `session:${id}`;
const keyUserSessions = (userId: string) => `sessions:byUser:${userId}`;

export function saveSession(sess: Session) {
  localStorage.setItem(keySession(sess.id), JSON.stringify(sess));
}

export function getSession(id: string): Session | null {
  const raw = localStorage.getItem(keySession(id));
  return raw ? JSON.parse(raw) as Session : null;
}

export function listUserSessions(userId: string): { id: string; title: string; lastAccessedAt: string|Date }[] {
  const raw = localStorage.getItem(keyUserSessions(userId));
  return raw ? JSON.parse(raw) : [];
}

export function upsertUserSessionSummary(userId: string, sess: Session) {
  const list = listUserSessions(userId);
  const next = list.filter(s => s.id !== sess.id);
  next.unshift({ id: sess.id, title: sess.title, lastAccessedAt: sess.lastAccessedAt });
  localStorage.setItem(keyUserSessions(userId), JSON.stringify(next.slice(0, 100)));
}

export function appendMessage(sessionId: string, msg: Message) {
  const sess = getSession(sessionId);
  if (!sess) return;
  const withTs = { ...msg, timestamp: msg.timestamp ?? new Date().toISOString() };
  sess.messages.push(withTs);
  sess.lastAccessedAt = new Date().toISOString();
  saveSession(sess);
}

export function appendInterpretiveResult(sessionId: string, result: InterpretiveResponse) {
  const sess = getSession(sessionId);
  if (!sess) return;
  sess.lastInterpretiveResult = result;
  sess.lastAccessedAt = new Date().toISOString();
  saveSession(sess);
}

export function removeSession(sessionId: string) {
  localStorage.removeItem(keySession(sessionId));
}
```

**Create and Cache a Session**
- After creating a session on the server, persist locally:
```
const session = await fetch('/sessions', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId, initialQuery }) }).then(r=>r.json());
saveSession(session);
upsertUserSessionSummary(userId, session);
```

**Send a Message and Cache**
```
const updated = await fetch(`/sessions/${sessionId}/messages`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ role:'user', type:'text', content: query }) }).then(r=>r.json());
saveSession(updated);
upsertUserSessionSummary(updated.userId, updated);
```

**Interpret (non-stream) and Cache**
```
const resp = await fetch('/interpret', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query, sessionId }) }).then(r=>r.json());
appendMessage(sessionId, { role:'assistant', type:'interpretive', content: resp });
appendInterpretiveResult(sessionId, resp);
```

**Interpret (stream, SSE) and Cache**
- Open an `EventSource` to a streaming endpoint variant you expose (ensure your client includes the same params). As chunks arrive, update a draft assistant message, then finalize on `complete`.
```
// Pseudocode; adapt to your SSE transport
const draftId = 'assistant-draft';
appendMessage(sessionId, { role:'assistant', type:'interpretive', content: '', id: draftId });

const es = new EventSource(`/interpret/stream?sessionId=${sessionId}&query=${encodeURIComponent(query)}`);
es.addEventListener('token', (ev: MessageEvent) => {
  const { chunk } = JSON.parse(ev.data);
  const sess = getSession(sessionId);
  if (!sess) return;
  const msg = sess.messages.find(m => (m.id === draftId));
  if (msg && typeof msg.content === 'string') {
    msg.content += chunk;
    saveSession(sess);
  }
});
es.addEventListener('complete', (ev: MessageEvent) => {
  const payload = JSON.parse(ev.data).payload; // InterpretiveResponse
  appendInterpretiveResult(sessionId, payload);
  es.close();
});
es.addEventListener('error', () => es.close());
```

**Hydrate from Server (optional reconciliation)**
- When opening a session, fetch latest server snapshot and replace local if newer.
```
const server = await fetch(`/sessions/${sessionId}`).then(r=>r.json());
saveSession(server);
upsertUserSessionSummary(server.userId, server);
```

**Quota & Limits**
- If LocalStorage quota errors occur, prune older sessions from `sessions:byUser:<userId>` and remove their corresponding `session:<id>` entries, or migrate to IndexedDB.

