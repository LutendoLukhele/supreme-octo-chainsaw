# ASO predeploy release-candidate checklist

This is the release gate before deploying ASO to Hetzner. Do not treat a green
build alone as deploy-ready. The release candidate must pass the code, Linux
runtime, model, Nango, artifact, API, UI, and production-configuration gates.

## Current local status: June 5, 2026

Green:

- Deterministic clean Docker build and unchanged-build cache proof.
- Local Hetzner preflight across env, models, Nango runtime, and artifacts.
- Linux ONNX model load and canonical classifier/workflow recovery.
- Four typed plus ten ONNX workflow-lane cases.
- Gmail active-connection warmup and read-only `fetch_emails` execution.
- Real DOCX generation, Flutter artifact envelope, download, and persistence
  after backend recreation.
- Workflow/artifact HTTP routes enforce owner-scoped access before returning
  workflow metadata, artifact lists, or document downloads.
- Backend health, bootstrap status, metrics, and backend-to-Nango health.

No-go until completed:

- Rotate the Neon and Redis credentials that previously appeared in tracked
  operational scripts. Removing the hardcoded fallbacks does not invalidate
  credentials already present in Git history.
- Complete the incident/data-retention review for session payloads that were
  previously tracked. This branch removes runtime session data from the
  current tree, but Git history still requires an explicit purge decision.
- Resolve or formally risk-accept the two critical production dependency
  advisories reported by `npm audit --omit=dev`.
- Supply and validate the production Nango webhook secret.
- Run the strict preflight against real Hetzner paths and production URLs.
- Apply/verify production migrations, TLS, backup, and rollback.
- Run the Flutter UI acceptance flow in the UI repository.

## 1. Required local topology

Run self-hosted Nango and ASO as separate Compose projects.

The two Compose files both default to host ports `5432` and `6379`. Avoid the
collision by giving Nango alternate host-only database and Redis ports:

```bash
cd /Users/lutendolukhele/Desktop/aisonango-master

NANGO_DB_PORT=5433 \
NANGO_REDIS_PORT=6380 \
docker compose --env-file /absolute/path/to/nango-production-like.env up -d
```

The current Nango checkout does not contain
`deploy/aso-self-hosted/.env`. Identify or create the real self-hosted Nango
env file before attempting a fresh restart. Do not stop the currently healthy
Nango containers until that file and its secrets are recoverable.

Expected Nango endpoints:

```text
API/dashboard: http://localhost:3003
Connect UI:    http://localhost:3009
Runtime dist:  /Users/lutendolukhele/Desktop/aisonango-master/nango-integrations-data/dist
```

Start the minimum ASO release-candidate stack:

```bash
cd /Users/lutendolukhele/Desktop/aso

ASO_MODEL_BUNDLE_PATH=/Users/lutendolukhele/Desktop/aso/.data/model-bundles/current/models \
ASO_ARTIFACTS_PATH=/Users/lutendolukhele/Desktop/aso/.data/artifacts \
NANGO_BASE_URL=http://host.docker.internal:3003 \
NANGO_PUBLIC_BASE_URL=http://localhost:3003 \
PUBLIC_API_BASE_URL=http://localhost:8080 \
CORS_ORIGINS=http://localhost:54059 \
ASO_ALLOW_TEST_AUTH_HEADER=1 \
docker compose up -d --build redis jaeger backend
```

`ASO_ALLOW_TEST_AUTH_HEADER=1` only enables the local
`x-aso-test-user-id` smoke-test header. Do not set it in production.

Start monitoring services only after the minimum stack passes:

```bash
docker compose up -d prometheus grafana loki promtail
```

Do not start `cloudflared` locally unless a tunnel token and a public callback
test are intentionally part of the rehearsal.

## 2. Code and contract gate

Run:

```bash
npm run build --workspace @aso/workflow-contracts
npx tsc -p . --noEmit
npm audit --omit=dev --audit-level=critical
npx jest \
  tests/unit/hetzner-preflight.test.ts \
  tests/unit/workflow-spec-factory.test.ts \
  tests/unit/workflow-artifact-auth-routes.test.ts \
  tests/unit/workflow-artifact-route-shape.test.ts \
  tests/unit/document-artifact-presenter.test.ts \
  tests/unit/desktop-method.service.test.ts \
  tests/unit/artifact-renderer.test.ts \
  --runInBand
```

Required results:

- Shared workflow contracts build before root TypeScript/Jest checks.
- TypeScript passes.
- Free-text Gmail attachment requests resolve to
  `gmail_emails_with_attachments`.
- The Flutter-facing document artifact envelope contains `filename`, `format`,
  `fileUrl`, `generationMode`, and optional preview fields.
- Server-only `renderedPath` and `filePath` are not exposed in the nested
  Flutter document artifact.
- Workflow and artifact HTTP routes require authentication and only return a
  user's own workflow metadata, artifact lists, and document downloads.
- Production dependencies have no untriaged critical advisories.

### Production dependency security triage

The June 5, 2026 `npm audit --omit=dev` result is a production no-go:

```text
57 vulnerabilities: 1 low, 22 moderate, 32 high, 2 critical
```

Known upgrade lanes:

- Firebase/storage/XML: `apps/backend` uses `firebase-admin@12.7.0`, while the
  root uses `firebase-admin@13.4.0`. Both reach
  `@google-cloud/storage@7.17.0 -> fast-xml-parser@4.5.3`. Audit recommends
  upgrading/aligning Firebase Admin to at least `13.10.0`.
- OpenTelemetry/protobuf: the root and observability workspace use
  `@opentelemetry/sdk-node@0.211.0`; the exporters and gRPC chain reach
  vulnerable `protobufjs@7.5.4` and `protobufjs@8.0.0`. Audit recommends a
  coordinated upgrade to SDK/exporters `0.218.0` and auto-instrumentations
  `0.76.0`.
- Remaining high advisories include the Nango/axios and React Router chains.
  The current `xlsx` advisory has no upstream fix and requires explicit
  mitigation or risk acceptance.

Do not run `npm audit fix --force` on the release branch. Resolve these as a
separate dependency-upgrade lane, regenerate the lockfile, rebuild the exact
production image, and rerun:

```bash
npm audit --omit=dev
npx tsc -p . --noEmit
npx jest --runInBand
docker compose build --no-cache backend
docker compose run --rm backend node dist/scripts/validate-onnx-runtime.js
npm run test:e2e:workflow
npm run test:e2e:workflow-artifact-docx
```

The release can proceed with unresolved advisories only when the owner,
expiry, affected surface, mitigation, and rollback trigger are recorded in an
approved risk acceptance.

## 3. Preflight path and environment gate

The real local paths currently are:

```text
Model root:
/Users/lutendolukhele/Desktop/aso/.data/model-bundles/current/models

Nango runtime dist:
/Users/lutendolukhele/Desktop/aisonango-master/nango-integrations-data/dist
```

Run the local path proof:

```bash
PUBLIC_API_BASE_URL=http://localhost:8080 \
NANGO_PUBLIC_BASE_URL=http://localhost:3003 \
NANGO_WEBHOOK_SECRET=local-preflight-only \
CORS_ORIGINS=http://localhost:54059 \
npm run predeploy:hetzner -- \
  --env-file .env \
  --model-root .data/model-bundles/current/models \
  --nango-dist /Users/lutendolukhele/Desktop/aisonango-master/nango-integrations-data/dist \
  --artifact-root .data/artifacts \
  --allow-local-defaults
```

The strict Hetzner run must use the production env file and production host
paths. Strict mode rejects HTTP or loopback values for the public API and Nango
URLs:

```bash
npm run predeploy:hetzner -- \
  --env-file /path/to/production.env \
  --model-root /srv/aso-model-bundles/current/models \
  --nango-dist /path/to/nango-integrations/dist \
  --artifact-root /srv/aso-data/artifacts
```

Required environment:

```text
DATABASE_URL
REDIS_URL or REDIS_PASSWORD
PUBLIC_API_BASE_URL
NANGO_BASE_URL
NANGO_PUBLIC_BASE_URL
NANGO_SECRET_KEY
NANGO_WEBHOOK_SECRET
CORS_ORIGINS
OPEN_AI_API_KEY
GROQ_API_KEY
FIREBASE_PROJECT_ID
FIREBASE_PRIVATE_KEY
FIREBASE_CLIENT_EMAIL
ASO_MODEL_BUNDLE_PATH, or both ML_INTENT_MODEL_DIR and ML_NER_MODEL_DIR
ASO_ARTIFACTS_PATH
NANGO_RUNTIME_DIST_DIR or NANGO_INTEGRATIONS_DIST_DIR when no explicit CLI path is supplied
```

In strict mode, `PUBLIC_API_BASE_URL` and `NANGO_PUBLIC_BASE_URL` must be
non-loopback HTTPS URLs. Every `CORS_ORIGINS` entry must also be a non-loopback
HTTPS origin with no path, query, fragment, or wildcard.
`ASO_ALLOW_TEST_AUTH_HEADER=1` is local-only; strict production preflight
rejects it so document routes require Firebase bearer authentication.

## 4. Linux ONNX classifier gate

The macOS host may not have a compatible `onnxruntime-node` native binary.
Production readiness is decided by the Linux container, not the macOS process.

Build the backend image:

```bash
docker compose build backend
```

Run both classifiers and canonical workflow recovery inside Linux:

```bash
docker compose run --rm backend node dist/scripts/validate-onnx-runtime.js
```

Required results:

- `onnxruntime-node` loads without native binding errors.
- Intent classifier model loads from `/app/models/intent_classifier`.
- NER model loads from `/app/models/ner_extractor`.
- Every canonical sample returns `source: "onnx"`.
- Every canonical sample converts into a valid `WorkflowSpec`.

## 5. Nango runtime and provider gate

Check the self-hosted Nango health endpoint:

```bash
curl http://localhost:3003/health
```

The mounted runtime `dist` must contain non-empty compiled JS for:

```text
Gmail:
fetch-emails-google-mail-ynxw.js
fetch-attachment-google-mail-ynxw.js
send-email-google-mail-ynxw.js
emails-google-mail-ynxw.js

Google Calendar:
calendar-fetch-events-google-calendar.js
calendar-create-event-google-calendar.js
calendar-update-event-google-calendar.js
events-google-calendar.js

Salesforce:
salesforce-fetch-entity-salesforce-ybzg.js
salesforce-create-entity-salesforce-ybzg.js
salesforce-update-entity-salesforce-ybzg.js
entities-salesforce-ybzg.js
```

Run:

```bash
export ASO_TEST_CONNECTION_ID=<gmail-connection-id>
export ASO_TEST_PROVIDER_CONFIG_KEY=google-mail-ynxw
export ASO_E2E_REQUIRE_WARMED=1

npm run test:e2e:nango-active-connection
npm run test:e2e:nango-readonly-fetch
```

Write-provider tests are optional before every release, but must pass before a
provider write feature is enabled in production:

```bash
npm run test:e2e:nango-provider
```

## 6. Workflow and artifact gate

Run plan-generation coverage:

```bash
npm run test:e2e:workflow
```

Run the real DOCX artifact and download-contract smoke inside the production
Linux image with the same artifact mount used by the backend:

```bash
docker run --rm \
  --network aso_backend-network \
  --env-file .env \
  -e NODE_PATH=/app/node_modules \
  -e API_BASE_URL=http://backend:8080 \
  -e PUBLIC_API_BASE_URL=http://backend:8080 \
  -e WORKFLOW_SMOKE_RUNTIME=dist \
  -e WORKFLOW_SMOKE_USER_ID=workflow-docx-smoke \
  -v "$PWD/.data/artifacts:/app/.data/artifacts" \
  -v "$PWD/tests/e2e/workflow-artifact-docx-smoke.js:/tmp/workflow-artifact-docx-smoke.js:ro" \
  aso-backend node /tmp/workflow-artifact-docx-smoke.js
```

Required results:

- A workflow compiles into query and `generate_file` nodes.
- A real `.docx` is written under `.data/artifacts`.
- `GET /api/workflows/:workflowId/artifacts` returns the Flutter document
  artifact shape.
- `GET /api/artifacts/:artifactId/download` returns a non-empty ZIP/DOCX body
  with the expected filename.
- Recreating the backend preserves the generated DOCX and the same download URL
  continues returning it.
- The authorization layer prevents one user from listing or downloading
  another user's workflow artifacts.

## 7. Backend API and operational gate

Required health checks:

```bash
curl http://localhost:8080/health/detailed
curl http://localhost:8080/bootstrap-status
curl http://localhost:8080/metrics/bootstrap
```

Inspect container health and logs:

```bash
docker compose ps
docker compose logs --tail=200 backend
docker compose logs --tail=200 redis
docker compose logs --tail=200 jaeger
```

Required results:

- Backend container is healthy.
- No repeated database, Redis, model-loading, or Nango errors.
- Artifact directory is writable by the non-root backend user.
- Artifact directory is mounted to persistent host storage.
- Model mount is read-only.
- Restarting the backend preserves required database state and does not break
  model discovery.

## 8. Flutter UI integration gate

The Flutter client must treat the backend as the only public integration
boundary. It must not use Nango secret credentials.

Required UI flows:

- Send typed workflow payloads using `workflow_compose`.
- Display free-text recovered workflow plans.
- Confirm a multi-step plan before execution.
- Render running, completed, partial-success, and failed workflow states.
- Read document artifacts from:
  `GET /api/workflows/:workflowId/artifacts`.
- Open/download documents using nested `artifact.fileUrl`.
- Handle artifact statuses `compiled`, `rendering`, `ready`, and `error`.
- Handle download responses `404`, `409`, and `403`.
- Never depend on backend-local `filePath` or `renderedPath`.
- Show reconnect UI when a provider connection becomes `needs_reauth`.

Minimum document artifact shape:

```json
{
  "artifactId": "artifact_...",
  "status": "ready",
  "artifact": {
    "filename": "artifact_....docx",
    "format": "docx",
    "fileUrl": "https://api.example.com/api/artifacts/artifact_.../download",
    "generationMode": "server",
    "previewText": "..."
  }
}
```

UI acceptance test:

1. Compose Gmail attachments to Word summary.
2. Confirm and run the plan.
3. Observe progress until completion.
4. Display the returned document artifact.
5. Download/open the DOCX from `artifact.fileUrl`.
6. Verify reconnect and error states with mocked responses.

## 9. Hetzner production gate

Before deployment, collect:

- SSH access and ASO deploy directory.
- Confirmation that previously exposed database and Redis credentials were
  rotated and old credentials were revoked.
- Confirmation that the tracked-session-data incident review and any required
  Git-history purge are complete.
- Production env-file path.
- Production model bundle host path.
- Production Nango runtime-dist host path.
- Docker/Compose version.
- Public backend and Nango domains.
- Reverse proxy/TLS ownership.
- Backup and rollback locations.

Then verify:

```bash
docker inspect beat-engine-backend \
  --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

Required production results:

- Model host path mounts to `/app/models:ro`.
- `intent_classifier` and `ner_extractor` files exist in the mounted path.
- Nango runtime files exist in the path mounted to
  `/app/nango/nango-integrations/dist`.
- Public URLs use HTTPS.
- `CORS_ORIGINS` contains only intended UI origins.
- Nango webhook secret is configured on both sides.
- Database migrations are applied before backend rollout.
- Rollback image and previous model bundle remain available.

## 10. Go/no-go decision

Go only when:

- Code/unit/type checks pass.
- Previously exposed database and Redis credentials are rotated and revoked.
- Previously tracked runtime session data has completed incident review and
  any required Git-history purge.
- Production dependency critical advisories are resolved or formally
  risk-accepted.
- Strict preflight passes against production paths.
- Linux ONNX validation passes.
- Nango health and read-only provider execution pass.
- Workflow lane passes.
- DOCX route/download smoke passes.
- Flutter UI document workflow passes.
- Hetzner mounts, env, TLS, migrations, backup, and rollback are verified.

Any failed required item is a no-go until resolved or explicitly removed from
release scope.
