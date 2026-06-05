# ASO Workflow Lane E2E Results

Date: 2026-06-05
Target: live ASO backend Docker container
Transport: WebSocket
Model path: mounted runtime model bundle at `/app/models`
Database state: workflow/artifact migrations applied (`workflow_specs`, `workflow_artifacts`)

## What was tested

This test verifies the new product workflow lane, not the old LLM planner smoke path.

It covers two ingress modes:

1. **Typed slot workflows** from the frontend-style `workflow_compose` payload.
   - Source should be `ui_slot`.
   - Backend should not interpret prose.
   - Backend should compile deterministic workflow plans from preset IDs.

2. **Free-text workflow recovery** through ONNX intent + NER.
   - Source should be `onnx`.
   - Known task shapes should recover to `WorkflowSpec`.
   - LLM planner should not be needed for these known shapes.

The reusable test runner is:

```bash
node tests/e2e/workflow-lane-e2e.js
```

For the Docker-network test run:

```bash
docker run --rm --network aso_backend-network \
  -e NODE_PATH=/app/node_modules \
  -e WS_URL=ws://backend:8080 \
  -v "$PWD/tests/e2e/workflow-lane-e2e.js:/tmp/workflow-lane-e2e.js:ro" \
  aso-backend node /tmp/workflow-lane-e2e.js
```

## Summary

| Metric | Result |
|---|---:|
| Total cases | 14 |
| Passed | 14 |
| Failed | 0 |
| Typed UI-slot cases | 4 |
| ONNX free-text cases | 10 |
| Total compiled plan nodes | 32 |
| Min plan nodes per case | 2 |
| Max plan nodes per case | 4 |
| Artifact-producing cases | 9 |
| Total runtime | 14.241s |

## Case results

| # | Case | Source | Expected workflow shape | Plan nodes | Tools |
|---:|---|---|---|---:|---|
| 1 | Typed warm Salesforce deals today to internal email drafts | `ui_slot` | `warm_salesforce_deals` + `today` + `email_drafts` | 2 | `fetch_entity`, `create_internal_email_draft` |
| 2 | Typed Gmail attachments last 30 days to Word artifact | `ui_slot` | `gmail_emails_with_attachments` + `last_30_days` + `word_summary` | 2 | `fetch_emails`, `generate_file` |
| 3 | Typed dependent DAG: Salesforce PDF branch then Slack update | `ui_slot` | `warm_salesforce_deals/today/pdf_brief` then `recent_slack_mentions/last_7_days/slack_post` | 4 | `fetch_entity`, `generate_file`, `fetch_slack_messages`, `send_slack_message` |
| 4 | Typed independent DAG: Gmail + Calendar branches | `ui_slot` | independent `unread_gmail_threads/last_30_days/notion_page` and `upcoming_google_calendar_events/this_week/calendar_blocks` | 4 | `fetch_emails`, `create_notion_page`, `fetch_calendar_events`, `create_calendar_event` |
| 5 | Free text warm Salesforce deals today to email drafts | `onnx` | `warm_salesforce_deals` + `today` + `email_drafts` | 2 | `fetch_entity`, `create_internal_email_draft` |
| 6 | Free text Slack mentions last 7 days to PDF brief | `onnx` | `recent_slack_mentions` + `last_7_days` + `pdf_brief` | 2 | `fetch_slack_messages`, `generate_file` |
| 7 | Free text Calendar this week to Notion summary page | `onnx` | `upcoming_google_calendar_events` + `this_week` + `notion_page` | 2 | `fetch_calendar_events`, `create_notion_page` |
| 8 | Free text new Salesforce leads last 30 days to Excel report | `onnx` | `new_salesforce_leads` + `last_30_days` + `excel_report` | 2 | `fetch_entity`, `generate_file` |
| 9 | Free text stalled high-value deals this month to Slack post | `onnx` | `stalled_high_value_deals` + `this_month` + `slack_post` | 2 | `fetch_entity`, `send_slack_message` |
| 10 | Free text unread Gmail last 30 days to Notion page | `onnx` | `unread_gmail_threads` + `last_30_days` + `notion_page` | 2 | `fetch_emails`, `create_notion_page` |
| 11 | Free text Gmail attachments phrase to Word summary | `onnx` | `gmail_emails_with_attachments` + `today` + `word_summary` | 2 | `fetch_emails`, `generate_file` |
| 12 | Free text Notion meeting notes last 7 days to email drafts | `onnx` | `recent_notion_meeting_notes` + `last_7_days` + `email_drafts` | 2 | `fetch_notion_page`, `create_internal_email_draft` |
| 13 | Free text key Salesforce accounts this month to calendar blocks | `onnx` | `key_salesforce_accounts` + `this_month` + `calendar_blocks` | 2 | `fetch_entity`, `create_calendar_event` |
| 14 | Free text open support cases this week to PDF brief | `onnx` | `open_salesforce_cases` + `this_week` + `pdf_brief` | 2 | `fetch_entity`, `generate_file` |

## Typical usage coverage

The test matrix covers the main user-facing product paths:

- CRM work: opportunities, stalled deals, leads, accounts, support cases.
- Email work: unread Gmail threads and attachment-heavy Gmail requests.
- Calendar work: upcoming meetings/events and scheduling blocks.
- Slack work: recent mentions and outbound status updates.
- Notion work: meeting notes and generated summary pages.
- Artifact work: internal email drafts, PDF briefs, Excel reports, Word summaries.
- Workflow graph behavior: single-step flows, independent branches, and explicit dependencies.

## Variance findings

### Strong behavior

Known workflow-shaped language reliably converged to typed workflow specs. Examples:

- “Find warm Salesforce deals due today…” recovered `warm_salesforce_deals/today/email_drafts`.
- “Find recent Slack messages… last 7 days… PDF executive brief” recovered `recent_slack_mentions/last_7_days/pdf_brief`.
- “Find new Salesforce leads from the last 30 days… Excel report” recovered `new_salesforce_leads/last_30_days/excel_report`.

The `last_7_days` path was explicitly checked to ensure it does **not** regress into the previous `limit: 7` bug.

### Attachment-routing regression closed

Free text for:

```text
Show me Gmail emails with attachments from the inbox today and generate a Word summary document
```

now compiles to:

```text
gmail_emails_with_attachments + today + word_summary
```

The ONNX label remains in the `fetch_emails__generate_file` family. The
deterministic `WorkflowSpecFactory.whatPresetFromClassification(...)` recovery
now checks extracted slots and prose for attachment cues before selecting the
Gmail preset.

Typed UI payloads do not have this issue because they send the exact `gmail_emails_with_attachments` preset ID.

## Interpretation

The backend workflow lane is working as intended for launch-critical known shapes:

- UI slots are canonical typed payloads.
- ONNX recovers free text into the same canonical workflow model.
- The compiler emits executable plan nodes with explicit tools and dependencies.
- Artifact-producing outputs create durable artifact specs in the plan path.
- The old LLM planner is not required for these tested product workflows.

The next release gate is the Flutter acceptance flow for the generated document
artifact and public download URL.
