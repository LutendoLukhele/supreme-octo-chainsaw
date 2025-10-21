# Interpret Streaming Client Integration

This guide explains how to consume the `/api/interpret` streaming endpoint that now emits Server‑Sent Events (SSE) while the backend streams Groq tokens, optional tool metadata, enrichment progress, and the final `InterpretiveResponse`.

---

## 1. Endpoint Contract

- URL: `POST /api/interpret`
- Headers: `Accept: text/event-stream`
- Body:
  ```json
  {
    "query": "groq vs openai speed comparison",
    "sessionId": "optional-session",
    "documentIds": ["optional-doc"],
    "enableArtifacts": true,
    "searchSettings": { "include_domains": ["*.substack.com"] },
    "stream": true
  }
  ```
- Response: SSE stream terminated by the backend once the interaction completes or the client disconnects.

---

## 2. Event Types

| Event                | Payload snippet (simplified)                                                                                    | Notes                                                                                         |
|----------------------|------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `start`              | `{ "requestId": "...", "status": "loading", "mode": "TARGETED" }`                                                | Fired once headers flush; ready to show a loading skeleton.                                   |
| `token`              | `{ "chunk": "partial text…" }`                                                                                   | Raw text deltas in arrival order; accumulate them to display “live typing”.                   |
| `reasoning`          | `{ "text": "Model reasoning line…" }`                                                                            | Optional Groq reasoning stream; show in side panel if desired.                                |
| `tool`               | `{ "toolCalls": [...] }`                                                                                         | Emits when Groq Compound invokes web search/tooling.                                          |
| `warning`            | `{ "type": "parse_error", "message": "Failed to parse …" }`                                                      | Indicates backend fell back to a guard-rail response.                                         |
| `enrichment_start`   | `{ "key": "cultural" }`                                                                                          | Fired before each enrichment pass; e.g. update UI chip to “Loading cultural insights…”.       |
| `enrichment_complete`| `{ "key": "social", "segmentsAdded": 3, "sourcesAdded": 2 }`                                                     | Fired when enrichment merges into the response.                                               |
| `enrichment_error`   | `{ "key": "visual", "message": "Failed to enrich: …" }`                                                          | Backend could not complete an enrichment; show a toast/anote.                                  |
| `artifact_generated` | `{ "hasArtifact": true }`                                                                                        | Artifact is attached to the final response.                                                   |
| `complete`           | `{ "requestId": "...", "status": "complete", "payload": { …InterpretiveResponse… } }`                            | Final structured payload; replace the staged response with this object.                      |
| `error`              | `{ "requestId": "...", "status": "error", "message": "Failed to process…" }`                                     | Fatal failure; stop listening.                                                                |

All payloads are valid JSON strings. `InterpretiveResponse.metadata.groqParseStatus` exposes whether the backend parsed the Groq JSON cleanly (`ok`), repaired surrounding noise (`repaired`), or fell back to a guard-rail response (`fallback`).

---

## 3. Recommended Client State Machine

1. **Initialise**
   - POST the JSON body using `fetch` or `axios`.
   - Pipe the response into an `EventSource` polyfill (`eventsource-parser`, `@microsoft/fetch-event-source`) because native `EventSource` cannot POST.
2. **Handle tokens**
   - Concatenate `token` events into a buffer to render a live transcript.
   - Optionally throttle UI updates to every 30–60 ms.
3. **Track enrichments**
   - Maintain `Map<string, 'pending' | 'complete' | 'error'>` keyed by `cultural | social | visual`.
   - Update on `enrichment_*` events.
4. **Final payload**
   - On `complete`, parse `payload` into your existing interpretive types.
   - Replace provisional state (buffered text, enrichment status) with the structured response.
5. **Errors & teardown**
   - On `warning` with `type === 'parse_error'`, surface an inline banner but still expect a `complete` event containing a fallback payload.
   - On `error`, abort the listener and show a retry CTA.

---

## 4. Example (React + fetch-event-source)

```ts
import { fetchEventSource } from '@microsoft/fetch-event-source';
import type { InterpretiveResponse } from './types';

interface StreamState {
  requestId?: string;
  mode?: string;
  transcript: string;
  enrichments: Record<string, 'pending' | 'complete' | 'error'>;
  final?: InterpretiveResponse;
  warnings: string[];
}

export async function runInterpretStream(body: Record<string, unknown>, onUpdate: (state: StreamState) => void) {
  const state: StreamState = {
    transcript: '',
    enrichments: { cultural: 'pending', social: 'pending', visual: 'pending' },
    warnings: [],
  };

  await fetchEventSource('/api/interpret', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    async onmessage(event) {
      switch (event.event) {
        case 'start': {
          const data = JSON.parse(event.data);
          state.requestId = data.requestId;
          state.mode = data.mode;
          break;
        }
        case 'token': {
          const { chunk } = JSON.parse(event.data);
          state.transcript += chunk;
          break;
        }
        case 'reasoning': {
          // Optional: append to a reasoning log.
          break;
        }
        case 'enrichment_start': {
          const { key } = JSON.parse(event.data) as { key: string };
          state.enrichments[key] = 'pending';
          break;
        }
        case 'enrichment_complete': {
          const { key } = JSON.parse(event.data) as { key: string };
          state.enrichments[key] = 'complete';
          break;
        }
        case 'enrichment_error': {
          const { key, message } = JSON.parse(event.data) as { key: string; message: string };
          state.enrichments[key] = 'error';
          state.warnings.push(message);
          break;
        }
        case 'warning': {
          const { message } = JSON.parse(event.data);
          state.warnings.push(message);
          break;
        }
        case 'complete': {
          const data = JSON.parse(event.data) as { payload: InterpretiveResponse };
          state.final = data.payload;
          break;
        }
        case 'error': {
          const { message } = JSON.parse(event.data);
          throw new Error(message);
        }
        default:
          break;
      }

      onUpdate({ ...state });
    },
    onerror(err) {
      throw err;
    },
  });
}
```

---

## 5. Handling Guard-Rail Responses

The backend now produces guard-rail fallbacks when Groq emits malformed JSON:

- `warning` event with `type: "parse_error"` — show a non-blocking notification.
- Final payload has `metadata.groqParseStatus === 'fallback'`. Treat `segments[0].text` as raw JSON for manual inspection and label the UI as “Fallback response”.
- Enrichment data may still exist because the backend retries enrichments even after a fallback.

---

## 6. WebSocket Alternative

If your client already maintains the existing `/ws` connection:

1. Forward the interpret request over the socket (wrap the REST body in a `"type": "interpret_stream"` message).
2. Mirror the SSE events into WebSocket messages (the backend already uses `StreamManager`; you just need to subscribe to the new event types).
3. Reuse the state machine above—the payload shapes are the same.

---

## 7. QA Checklist

- ✅ Skeleton appears immediately after `start`.
- ✅ Live transcript grows with `token`.
- ✅ Enrichment chips toggle between pending/complete/error.
- ✅ Fallback banner appears when `groqParseStatus === 'fallback'`.
- ✅ Final render uses `InterpretiveResponse` from `complete`.
- ✅ Stream closes cleanly and removing listeners prevents memory leaks.

Drop this document into the Codex agent or README to share the integration contract with frontend teammates.
