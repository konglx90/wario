import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProducer, pickReviewer } from '../src/prereview/router.js';
import {
  parseRiskReport,
  parseClaudeOutput,
  parseCodexOutput,
  runReviewerCli,
} from '../src/prereview/runner.js';
import { buildPrompt } from '../src/prereview/prompts.js';

// ============================================================
// Router tests
// ============================================================

test('detectProducer: claude from source', () => {
  assert.equal(detectProducer('claude-code'), 'claude');
  assert.equal(detectProducer('claude-code', 'bot'), 'claude');
  assert.equal(detectProducer(undefined, 'claude-bot-1'), 'claude');
  assert.equal(detectProducer('my-sys', 'CLAUDE-something'), 'claude');
});

test('detectProducer: codex from source', () => {
  assert.equal(detectProducer('codex'), 'codex');
  assert.equal(detectProducer('codex', 'bot'), 'codex');
  assert.equal(detectProducer(undefined, 'codex-task-1'), 'codex');
});

test('detectProducer: unknown when no hint', () => {
  assert.equal(detectProducer('random', 'bot'), 'unknown');
  assert.equal(detectProducer(), 'unknown');
  assert.equal(detectProducer('', ''), 'unknown');
});

test('pickReviewer: heterogeneous (claude → codex)', () => {
  const r = pickReviewer('claude');
  assert.equal(r.producer, 'claude');
  assert.equal(r.reviewer, 'codex');
  assert.equal(r.reason, 'heterogeneous');
});

test('pickReviewer: heterogeneous (codex → claude)', () => {
  const r = pickReviewer('codex');
  assert.equal(r.producer, 'codex');
  assert.equal(r.reviewer, 'claude');
  assert.equal(r.reason, 'heterogeneous');
});

test('pickReviewer: fallback (unknown → default)', () => {
  const r = pickReviewer('unknown', 'claude');
  assert.equal(r.reviewer, 'claude');
  assert.equal(r.reason, 'fallback');
});

test('pickReviewer: fallback (unknown → custom default)', () => {
  const r = pickReviewer('unknown', 'codex');
  assert.equal(r.reviewer, 'codex');
  assert.equal(r.reason, 'fallback');
});

// ============================================================
// Runner: parseRiskReport tests
// ============================================================

test('parseRiskReport: valid JSON', () => {
  const result = parseRiskReport(
    '{"riskLevel":"L2","summary":"two issues found","findings":[{"severity":"high","category":"security","description":"XSS risk","location":"src/auth.ts:42","suggestion":"sanitize input"}]}'
  );
  assert.ok(result);
  assert.equal(result.riskLevel, 'L2');
  assert.equal(result.summary, 'two issues found');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, 'high');
  assert.equal(result.findings[0].location, 'src/auth.ts:42');
  assert.equal(result.findings[0].suggestion, 'sanitize input');
});

test('parseRiskReport: JSON wrapped in markdown fence', () => {
  const result = parseRiskReport(
    'Here is my review:\n```json\n{"riskLevel":"L1","summary":"looks good","findings":[]}\n```\nDone.'
  );
  assert.ok(result);
  assert.equal(result.riskLevel, 'L1');
  assert.equal(result.summary, 'looks good');
  assert.equal(result.findings.length, 0);
});

test('parseRiskReport: invalid riskLevel rejected', () => {
  const result = parseRiskReport('{"riskLevel":"X","summary":"x","findings":[]}');
  assert.equal(result, undefined);
});

test('parseRiskReport: missing fields rejected', () => {
  assert.equal(parseRiskReport('{"summary":"x"}'), undefined);
  assert.equal(parseRiskReport('{"riskLevel":"L1"}'), undefined);
  assert.equal(parseRiskReport('not json at all'), undefined);
});

test('parseRiskReport: filters out malformed findings', () => {
  const result = parseRiskReport(
    '{"riskLevel":"L2","summary":"x","findings":[{"severity":"high","category":"c","description":"d"},{"severity":"bad","category":"c","description":"d"}]}'
  );
  assert.ok(result);
  assert.equal(result.findings.length, 1);
});

// ============================================================
// Runner: output parsing tests
// ============================================================

test('parseClaudeOutput: extracts result and session_id', () => {
  const stdout = JSON.stringify({
    type: 'result',
    result: 'the model text',
    session_id: 'abc-123',
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const parsed = parseClaudeOutput(stdout);
  assert.equal(parsed.modelText, 'the model text');
  assert.equal(parsed.sessionId, 'abc-123');
});

test('parseClaudeOutput: handles non-JSON stdout gracefully', () => {
  const parsed = parseClaudeOutput('not json at all');
  assert.equal(parsed.modelText, 'not json at all');
  assert.equal(parsed.sessionId, undefined);
});

test('parseClaudeOutput: handles JSON without session_id', () => {
  const stdout = JSON.stringify({ type: 'result', result: 'hi' });
  const parsed = parseClaudeOutput(stdout);
  assert.equal(parsed.modelText, 'hi');
  assert.equal(parsed.sessionId, undefined);
});

test('parseCodexOutput: extracts thread_id and agent_message', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-xyz' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'i1', type: 'agent_message', text: 'hello' },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'i2', type: 'agent_message', text: ' world' },
    }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
  const parsed = parseCodexOutput(stdout);
  assert.equal(parsed.sessionId, 'thread-xyz');
  assert.equal(parsed.modelText, 'hello world');
});

test('parseCodexOutput: empty stdout yields empty', () => {
  const parsed = parseCodexOutput('');
  assert.equal(parsed.modelText, '');
  assert.equal(parsed.sessionId, undefined);
});

test('parseCodexOutput: ignores non-JSON lines', () => {
  const stdout = 'not json\n' + JSON.stringify({ type: 'turn.started' }) + '\n';
  const parsed = parseCodexOutput(stdout);
  assert.equal(parsed.modelText, '');
  assert.equal(parsed.sessionId, undefined);
});

test('runReviewerCli: spawn failure rejected', async () => {
  await assert.rejects(
    () =>
      runReviewerCli(
        'claude',
        { command: 'definitely-not-a-command-xyz', baseArgs: [], timeoutMs: 5000 },
        'x'
      )
  );
});

// ============================================================
// Prompts tests
// ============================================================

test('buildPrompt: code by default', () => {
  const p = buildPrompt({
    projectSlug: 'p1',
    pushedBy: 'x',
    sessionId: 'sess-test',
    title: 'Fix login bug',
  });
  assert.match(p, /senior code reviewer/i);
  assert.match(p, /Title: Fix login bug/);
});

test('buildPrompt: requirement emphasizes completeness', () => {
  const p = buildPrompt({
    projectSlug: 'p1',
    pushedBy: 'x',
    sessionId: 'sess-test',
    title: 'X',
    contentType: 'requirement',
  });
  assert.match(p, /completeness|ambiguity/i);
});

test('buildPrompt: plan emphasizes feasibility', () => {
  const p = buildPrompt({
    projectSlug: 'p1',
    pushedBy: 'x',
    sessionId: 'sess-test',
    title: 'X',
    contentType: 'plan',
  });
  assert.match(p, /feasibility|side effect/i);
});

test('buildPrompt: code emphasizes correctness/security', () => {
  const p = buildPrompt({
    projectSlug: 'p1',
    pushedBy: 'x',
    sessionId: 'sess-test',
    title: 'X',
    contentType: 'code',
  });
  assert.match(p, /correctness|security/i);
});

test('buildPrompt: includes diff and tags when provided', () => {
  const p = buildPrompt({
    projectSlug: 'p1',
    pushedBy: 'x',
    sessionId: 'sess-test',
    title: 'X',
    diff: '+ added line\n- removed line',
    tags: ['ui', 'frontend'],
    selfAssessedRisk: 'L2',
  });
  assert.match(p, /\+ added line/);
  assert.match(p, /Tags: ui, frontend/);
  assert.match(p, /L2/);
});

test('buildPrompt: every prompt asks for JSON output', () => {
  for (const ct of ['requirement', 'plan', 'code'] as const) {
    const p = buildPrompt({
      projectSlug: 'p1',
      pushedBy: 'x',
    sessionId: 'sess-test',
      title: 'X',
      contentType: ct,
    });
    assert.match(p, /JSON/);
    assert.match(p, /riskLevel/);
  }
});