import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createProject } from '../src/domain/project.js';
import {
  decideReview,
  listReviews,
  ProjectNotFoundError,
  pushReview,
  ReviewAlreadyDecidedError,
  ReviewNotFoundError,
  showReview,
  waitForDecision,
} from '../src/domain/review.js';

function setup(): { db: any; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wario-rv-'));
  const path = join(dir, 'data.db');
  const db = openDatabase(path);
  return { db, dir, path };
}

function cleanup(db: any, dir: string): void {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

test('pushReview assigns id and persists full context', () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    const r = pushReview(db, {
      projectSlug: 'p1',
      pushedBy: 'claude-code',
      sessionId: 'sess-abc-001',
      title: '登录页 UI 还原',
      description: '详情描述',
      diff: '+ line 1\n- line 2',
      tags: ['ui', 'frontend'],
      source: 'claude-code',
      sourceRef: 'task-123',
      selfAssessedRisk: 'L2',
    });
    assert.ok(r.id.startsWith('rv_'));
    assert.equal(r.status, 'pending');
    assert.equal(r.context.title, '登录页 UI 还原');
    assert.equal(r.context.description, '详情描述');
    assert.equal(r.context.diff, '+ line 1\n- line 2');
    assert.deepEqual(r.context.tags, ['ui', 'frontend']);
    assert.equal(r.context.source, 'claude-code');
    assert.equal(r.context.sourceRef, 'task-123');
    assert.equal(r.selfAssessedRisk, 'L2');

    const fetched = showReview(db, r.id);
    assert.ok(fetched);
    assert.equal(fetched.id, r.id);
    assert.equal(fetched.pushedBy, 'claude-code');
  } finally {
    cleanup(db, dir);
  }
});

test('pushReview fails on unknown project', () => {
  const { db, dir } = setup();
  try {
    assert.throws(
      () => pushReview(db, { projectSlug: 'nope', pushedBy: 'x', sessionId: 's1', title: 't' }),
      ProjectNotFoundError
    );
  } finally {
    cleanup(db, dir);
  }
});

test('pushReview persists sessionId and contentType', () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    const r = pushReview(db, {
      projectSlug: 'p1',
      pushedBy: 'claude-code',
      sessionId: 'sess-abc-123',
      title: '登录页 UI 还原',
      contentType: 'code',
    });
    assert.equal(r.sessionId, 'sess-abc-123');
    assert.equal(r.contentType, 'code');

    const fetched = showReview(db, r.id);
    assert.equal(fetched?.sessionId, 'sess-abc-123');
    assert.equal(fetched?.contentType, 'code');
  } finally {
    cleanup(db, dir);
  }
});

test('listReviews groups by sessionId', () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    pushReview(db, { projectSlug: 'p1', pushedBy: 'x', title: 'A', sessionId: 'sess-1' });
    pushReview(db, { projectSlug: 'p1', pushedBy: 'x', title: 'B', sessionId: 'sess-1' });
    pushReview(db, { projectSlug: 'p1', pushedBy: 'x', title: 'C', sessionId: 'sess-2' });
    pushReview(db, { projectSlug: 'p1', pushedBy: 'x', title: 'D' });
    const all = listReviews(db, { projectSlug: 'p1' });
    assert.equal(all.length, 4);
    assert.equal(all.filter(r => r.sessionId === 'sess-1').length, 2);
    assert.equal(all.filter(r => r.sessionId === 'sess-2').length, 1);
    assert.equal(all.filter(r => !r.sessionId).length, 1);
  } finally {
    cleanup(db, dir);
  }
});

test('listReviews filters by project and status', () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    createProject(db, { slug: 'p2', name: 'P2' });

    pushReview(db, { projectSlug: 'p1', pushedBy: 'x', title: 'A' });
    pushReview(db, { projectSlug: 'p1', pushedBy: 'x', title: 'B' });
    pushReview(db, { projectSlug: 'p2', pushedBy: 'x', title: 'C' });

    assert.equal(listReviews(db, { projectSlug: 'p1' }).length, 2);
    assert.equal(listReviews(db, { projectSlug: 'p2' }).length, 1);

    const p1All = listReviews(db, { projectSlug: 'p1' });
    decideReview(db, { reviewId: p1All[0].id, reviewer: 'r', verdict: 'approve' });

    assert.equal(
      listReviews(db, { projectSlug: 'p1', status: 'pending' }).length,
      1
    );
    assert.equal(
      listReviews(db, { projectSlug: 'p1', status: 'decided' }).length,
      1
    );
  } finally {
    cleanup(db, dir);
  }
});

test('decideReview records decision', () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    const r = pushReview(db, { projectSlug: 'p1', pushedBy: 'x', title: 'A' });
    const decided = decideReview(db, {
      reviewId: r.id,
      reviewer: 'alice',
      verdict: 'reject',
      comment: '登录态校验漏了',
    });
    assert.equal(decided.status, 'decided');
    assert.equal(decided.decision?.verdict, 'reject');
    assert.equal(decided.decision?.reviewer, 'alice');
    assert.equal(decided.decision?.comment, '登录态校验漏了');
    assert.ok(decided.decidedAt);
  } finally {
    cleanup(db, dir);
  }
});

test('decideReview throws on already decided', () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    const r = pushReview(db, { projectSlug: 'p1', pushedBy: 'x', title: 'A' });
    decideReview(db, { reviewId: r.id, reviewer: 'a', verdict: 'approve' });
    assert.throws(
      () =>
        decideReview(db, {
          reviewId: r.id,
          reviewer: 'b',
          verdict: 'reject',
        }),
      ReviewAlreadyDecidedError
    );
  } finally {
    cleanup(db, dir);
  }
});

test('decideReview throws on unknown id', () => {
  const { db, dir } = setup();
  try {
    assert.throws(
      () =>
        decideReview(db, {
          reviewId: 'rv_does_not_exist',
          reviewer: 'a',
          verdict: 'approve',
        }),
      ReviewNotFoundError
    );
  } finally {
    cleanup(db, dir);
  }
});

test('waitForDecision returns immediately if already decided', async () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    const r = pushReview(db, { projectSlug: 'p1', pushedBy: 'x', title: 'A' });
    decideReview(db, { reviewId: r.id, reviewer: 'a', verdict: 'approve' });

    const result = await waitForDecision(db, r.id, 60, 50);
    assert.equal(result.outcome, 'decided');
    assert.ok(result.review);
    assert.equal(result.review.decision.verdict, 'approve');
  } finally {
    cleanup(db, dir);
  }
});

test('waitForDecision returns timeout if pending and timeoutSec=0', async () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    const r = pushReview(db, { projectSlug: 'p1', pushedBy: 'x', title: 'A' });

    const result = await waitForDecision(db, r.id, 0);
    assert.equal(result.outcome, 'timeout');
  } finally {
    cleanup(db, dir);
  }
});

test('waitForDecision returns notfound for unknown id', async () => {
  const { db, dir } = setup();
  try {
    const result = await waitForDecision(db, 'rv_nope', 60, 50);
    assert.equal(result.outcome, 'notfound');
  } finally {
    cleanup(db, dir);
  }
});

test('waitForDecision picks up decision asynchronously', async () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    const r = pushReview(db, { projectSlug: 'p1', pushedBy: 'x', sessionId: 's1', title: 'A' });

    const start = Date.now();
    const waitPromise = waitForDecision(db, r.id, 5, 50);
    setTimeout(
      () => decideReview(db, { reviewId: r.id, reviewer: 'late', verdict: 'reject' }),
      150
    );

    const result = await waitPromise;
    const elapsed = Date.now() - start;

    assert.equal(result.outcome, 'decided');
    assert.equal(result.review?.decision.verdict, 'reject');
    assert.ok(elapsed < 1000, `should pick up within ~250ms, took ${elapsed}ms`);
  } finally {
    cleanup(db, dir);
  }
});

test('pushReview persists reviewSessionId column as null on push', () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    const r = pushReview(db, { projectSlug: 'p1', pushedBy: 'x', sessionId: 's1', title: 'A' });
    const row = db.prepare('SELECT review_session_id FROM review_requests WHERE id = ?').get(r.id) as { review_session_id: string | null };
    assert.equal(row.review_session_id, null);
  } finally {
    cleanup(db, dir);
  }
});

test('showReview returns reviewSessionId after pre-review writes it', () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    const r = pushReview(db, { projectSlug: 'p1', pushedBy: 'x', sessionId: 's1', title: 'A' });
    const fakeReport = {
      byAgent: 'codex' as const,
      reviewSessionId: 'thread-xyz',
      riskLevel: 'L2' as const,
      summary: 'ok',
      findings: [],
      createdAt: new Date().toISOString(),
    };
    db.prepare(
      'UPDATE review_requests SET pre_review = ?, review_session_id = ? WHERE id = ?'
    ).run(JSON.stringify(fakeReport), 'thread-xyz', r.id);

    const fetched = showReview(db, r.id);
    assert.equal(fetched?.reviewSessionId, 'thread-xyz');
    assert.equal(fetched?.preReview?.reviewSessionId, 'thread-xyz');
    assert.equal(fetched?.preReview?.byAgent, 'codex');
  } finally {
    cleanup(db, dir);
  }
});

test('same sessionId twice creates two independent reviews', () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    const r1 = pushReview(db, { projectSlug: 'p1', pushedBy: 'x', sessionId: 'same-sess', title: 'A' });
    const r2 = pushReview(db, { projectSlug: 'p1', pushedBy: 'x', sessionId: 'same-sess', title: 'B' });
    assert.notEqual(r1.id, r2.id);
    const list = listReviews(db, { projectSlug: 'p1' });
    assert.equal(list.length, 2);
    assert.equal(list.filter(r => r.sessionId === 'same-sess').length, 2);
  } finally {
    cleanup(db, dir);
  }
});