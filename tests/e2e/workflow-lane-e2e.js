#!/usr/bin/env node
/*
 * Workflow lane E2E for ASO backend.
 *
 * Runs against a live ASO WebSocket backend and verifies:
 * - typed slot payloads compile without LLM interpretation;
 * - ONNX free-text recovery converges onto WorkflowSpec;
 * - compiled plans include query + output nodes;
 * - artifact outputs and dependency edges survive transport.
 *
 * Usage from Docker network:
 *   docker run --rm --network aso_backend-network \
 *     -e NODE_PATH=/app/node_modules \
 *     -e WS_URL=ws://backend:8080 \
 *     -v "$PWD/tests/e2e/workflow-lane-e2e.js:/tmp/workflow-lane-e2e.js:ro" \
 *     aso-backend node /tmp/workflow-lane-e2e.js
 */

const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const WS_URL = process.env.WS_URL || 'ws://localhost:8080';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 45000);

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition, label) {
  if (!condition) throw new Error(label);
}

function summarize(frame) {
  const workflow = frame?.content?.workflowSpec;
  const steps = workflow?.steps || [];
  return {
    frameType: frame?.type,
    source: workflow?.source,
    label: workflow?.workflowLabel,
    confidence: workflow?.confidence,
    workflowId: workflow?.id,
    stepCount: steps.length,
    steps: steps.map((step) => ({
      id: step.id,
      what: step.query?.presetId,
      when: step.whenPresetId,
      output: step.output?.presetId,
      dependsOn: step.dependsOn || [],
    })),
    planNodes: Array.isArray(frame?.content?.planOverview) ? frame.content.planOverview.length : 0,
    tools: Array.isArray(frame?.content?.planOverview)
      ? frame.content.planOverview.map((node) => node.toolName)
      : [],
    artifactCount: Array.isArray(frame?.content?.planOverview)
      ? frame.content.planOverview.filter((node) => node.artifactSpecId || node.arguments?.input?.artifactSpec).length
      : 0,
    requiresConfirmation: frame?.content?.requiresConfirmation,
  };
}

function runCase(testCase) {
  return new Promise((resolve, reject) => {
    const sessionId = `workflow-e2e-${randomUUID()}`;
    const ws = new WebSocket(`${WS_URL}/${sessionId}`);
    const frames = [];
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`${testCase.name} timed out after ${TIMEOUT_MS}ms; frames=${frames.map((f) => f.type).join(',')}`));
    }, TIMEOUT_MS);

    ws.on('open', () => ws.send(JSON.stringify({ type: 'init' })));
    ws.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      frames.push(frame);
      if (frame.type === 'connection_ack' || frame.type === 'auth_success') return;
      if (frame.type === 'session_init') {
        ws.send(JSON.stringify(testCase.message));
        return;
      }
      if (frame.type === 'plan_generated' || frame.type === 'error') {
        clearTimeout(timer);
        const elapsedMs = Date.now() - startedAt;
        try {
          if (frame.type === 'error') {
            throw new Error(`${testCase.name} returned error frame: ${JSON.stringify(frame.content)}`);
          }
          const summary = summarize(frame);
          testCase.assert(summary, frame);
          ws.close();
          resolve({ name: testCase.name, elapsedMs, ...summary, notes: testCase.notes || [] });
        } catch (err) {
          ws.close();
          reject(err);
        }
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function expectSingle({ source, what, when, output, minPlanNodes = 2, tools = [] }) {
  return (summary) => {
    assertEq(summary.frameType, 'plan_generated', 'frame type');
    assertEq(summary.source, source, 'workflow source');
    assertEq(summary.stepCount, 1, 'step count');
    assertEq(summary.steps[0].what, what, 'what preset');
    assertEq(summary.steps[0].when, when, 'when preset');
    assertEq(summary.steps[0].output, output, 'output preset');
    assert(summary.planNodes >= minPlanNodes, `expected at least ${minPlanNodes} plan nodes, got ${summary.planNodes}`);
    for (const tool of tools) assert(summary.tools.includes(tool), `expected tool ${tool}, got ${summary.tools.join(',')}`);
    assertEq(summary.requiresConfirmation, true, 'requires confirmation');
  };
}

const cases = [
  {
    name: 'typed: warm Salesforce deals today -> internal email drafts',
    message: {
      type: 'workflow_compose',
      content: {
        schemaVersion: '1.0',
        steps: [{ id: 'step_1', whatPresetId: 'warm_salesforce_deals', whenPresetId: 'today', outputPresetId: 'email_drafts' }],
      },
    },
    assert: expectSingle({
      source: 'ui_slot',
      what: 'warm_salesforce_deals',
      when: 'today',
      output: 'email_drafts',
      tools: ['fetch_entity', 'create_internal_email_draft'],
    }),
  },
  {
    name: 'typed: Gmail attachments last 30 days -> Word artifact',
    message: {
      type: 'workflow_compose',
      content: {
        schemaVersion: '1.0',
        steps: [{ id: 'step_1', whatPresetId: 'gmail_emails_with_attachments', whenPresetId: 'last_30_days', outputPresetId: 'word_summary' }],
      },
    },
    assert: (summary) => {
      expectSingle({
        source: 'ui_slot',
        what: 'gmail_emails_with_attachments',
        when: 'last_30_days',
        output: 'word_summary',
        tools: ['fetch_emails', 'generate_file'],
      })(summary);
      assert(summary.artifactCount >= 1, 'expected generated document artifact node');
    },
  },
  {
    name: 'typed DAG: dependent Slack update waits for Salesforce PDF branch',
    message: {
      type: 'workflow_compose',
      content: {
        schemaVersion: '1.0',
        steps: [
          { id: 'step_1', whatPresetId: 'warm_salesforce_deals', whenPresetId: 'today', outputPresetId: 'pdf_brief' },
          { id: 'step_2', whatPresetId: 'recent_slack_mentions', whenPresetId: 'last_7_days', outputPresetId: 'slack_post', dependsOn: ['step_1'] },
        ],
      },
    },
    assert: (summary, frame) => {
      assertEq(summary.source, 'ui_slot', 'workflow source');
      assertEq(summary.stepCount, 2, 'step count');
      assertEq(summary.steps[1].dependsOn[0], 'step_1', 'step dependency');
      assert(summary.planNodes >= 4, `expected at least 4 plan nodes, got ${summary.planNodes}`);
      assert(summary.tools.includes('generate_file'), 'expected generate_file tool');
      assert(summary.tools.includes('send_slack_message'), 'expected send_slack_message tool');
      assert((frame.content.workflowSpec.dependencies || []).length === 1, 'expected one workflow dependency edge');
    },
  },
  {
    name: 'typed DAG: independent Gmail + Calendar branches compile together',
    message: {
      type: 'workflow_compose',
      content: {
        schemaVersion: '1.0',
        steps: [
          { id: 'step_1', whatPresetId: 'unread_gmail_threads', whenPresetId: 'last_30_days', outputPresetId: 'notion_page' },
          { id: 'step_2', whatPresetId: 'upcoming_google_calendar_events', whenPresetId: 'this_week', outputPresetId: 'calendar_blocks' },
        ],
      },
    },
    assert: (summary, frame) => {
      assertEq(summary.source, 'ui_slot', 'workflow source');
      assertEq(summary.stepCount, 2, 'step count');
      assert(summary.steps.every((step) => step.dependsOn.length === 0), 'expected independent steps');
      assert((frame.content.workflowSpec.dependencies || []).length === 0, 'expected no workflow dependency edges');
      assert(summary.planNodes >= 4, `expected at least 4 plan nodes, got ${summary.planNodes}`);
    },
  },
  {
    name: 'onnx: warm Salesforce deals today -> email drafts',
    message: { type: 'content', content: 'Find warm Salesforce deals due today and draft personalised follow-up emails for each' },
    assert: expectSingle({ source: 'onnx', what: 'warm_salesforce_deals', when: 'today', output: 'email_drafts', tools: ['fetch_entity', 'create_internal_email_draft'] }),
  },
  {
    name: 'onnx: Slack mentions last 7 days -> PDF brief',
    message: { type: 'content', content: 'Find recent Slack messages that mention me or my deals from the last 7 days and generate a PDF executive brief' },
    assert: (summary, frame) => {
      expectSingle({ source: 'onnx', what: 'recent_slack_mentions', when: 'last_7_days', output: 'pdf_brief', tools: ['fetch_slack_messages', 'generate_file'] })(summary);
      assert(!JSON.stringify(frame.content.workflowSpec).includes('"limit":7'), 'last 7 days must not become limit:7');
    },
  },
  {
    name: 'onnx: Calendar this week -> Notion summary page',
    message: { type: 'content', content: 'Find upcoming Google Calendar events due this week and create a structured Notion summary page' },
    assert: expectSingle({ source: 'onnx', what: 'upcoming_google_calendar_events', when: 'this_week', output: 'notion_page', tools: ['fetch_calendar_events', 'create_notion_page'] }),
  },
  {
    name: 'onnx: new Salesforce leads last 30 days -> Excel report',
    message: { type: 'content', content: 'Find new Salesforce leads from the last 30 days and generate an Excel report with full data' },
    assert: expectSingle({ source: 'onnx', what: 'new_salesforce_leads', when: 'last_30_days', output: 'excel_report', tools: ['fetch_entity', 'generate_file'] }),
  },
  {
    name: 'onnx: stalled high-value deals this month -> Slack post',
    message: { type: 'content', content: 'Find stalled Salesforce deals over R100k due this month and post a concise pipeline update to Slack' },
    assert: expectSingle({ source: 'onnx', what: 'stalled_high_value_deals', when: 'this_month', output: 'slack_post', tools: ['fetch_entity', 'send_slack_message'] }),
  },
  {
    name: 'onnx: unread Gmail last 30 days -> Notion page',
    message: { type: 'content', content: 'Pull unread Gmail threads excluding promotions from the last 30 days and create a structured Notion summary page' },
    assert: expectSingle({ source: 'onnx', what: 'unread_gmail_threads', when: 'last_30_days', output: 'notion_page', tools: ['fetch_emails', 'create_notion_page'] }),
  },
  {
    name: 'onnx: Gmail attachments today -> Word artifact',
    message: { type: 'content', content: 'Show me Gmail emails with attachments from the inbox today and generate a Word summary document' },
    assert: expectSingle({ source: 'onnx', what: 'gmail_emails_with_attachments', when: 'today', output: 'word_summary', tools: ['fetch_emails', 'generate_file'] }),
  },
  {
    name: 'onnx: Notion meeting notes last 7 days -> email drafts',
    message: { type: 'content', content: 'Find recent Notion meeting note pages from the last 7 days and draft personalised follow-up emails for each' },
    assert: expectSingle({ source: 'onnx', what: 'recent_notion_meeting_notes', when: 'last_7_days', output: 'email_drafts', tools: ['fetch_notion_page', 'create_internal_email_draft'] }),
  },
  {
    name: 'onnx: key accounts this month -> Calendar blocks',
    message: { type: 'content', content: 'Find top Salesforce accounts by deal value this month and schedule review calls on Google Calendar' },
    assert: expectSingle({ source: 'onnx', what: 'key_salesforce_accounts', when: 'this_month', output: 'calendar_blocks', tools: ['fetch_entity', 'create_calendar_event'] }),
  },
  {
    name: 'onnx: open support cases this week -> PDF brief',
    message: { type: 'content', content: 'Find open Salesforce support cases this week and generate a PDF executive brief' },
    assert: expectSingle({ source: 'onnx', what: 'open_salesforce_cases', when: 'this_week', output: 'pdf_brief', tools: ['fetch_entity', 'generate_file'] }),
  },
];

(async () => {
  const startedAt = Date.now();
  const results = [];
  for (const testCase of cases) {
    const result = await runCase(testCase);
    results.push(result);
    console.log(`PASS ${result.name} (${result.elapsedMs}ms)`);
  }

  const summary = {
    ok: true,
    wsUrl: WS_URL,
    total: results.length,
    passed: results.length,
    failed: 0,
    durationMs: Date.now() - startedAt,
    sources: results.reduce((acc, r) => {
      acc[r.source] = (acc[r.source] || 0) + 1;
      return acc;
    }, {}),
    planNodes: {
      min: Math.min(...results.map((r) => r.planNodes)),
      max: Math.max(...results.map((r) => r.planNodes)),
      total: results.reduce((sum, r) => sum + r.planNodes, 0),
    },
    artifactCases: results.filter((r) => r.artifactCount > 0).length,
    results,
  };

  console.log('\nWORKFLOW_E2E_SUMMARY');
  console.log(JSON.stringify(summary, null, 2));
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
