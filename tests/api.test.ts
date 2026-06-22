import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openDatabase } from '../src/db/index.js';
import { registerProjectRoutes } from '../src/api/projects.js';
import { registerReviewRoutes } from '../src/api/reviews.js';

interface Setup {
  app: any;
  db: any;
  dir: string;
}

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'wario-api-'));
  const path = join(dir, 'data.db');
  const db = openDatabase(path);
  const app = Fastify();
  registerProjectRoutes(app, db);
  registerReviewRoutes(app, db);
  return { app, db, dir };
}

async function cleanup(s: Setup): Promise<void> {
  await s.app.close();
  rmSync(s.dir, { recursive: true, force: true });
}

test('POST /api/projects creates project and returns 201', async () => {
  const s = setup();
  try {
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { slug: 'foo', name: 'Foo', description: 'd' },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.slug, 'foo');
    assert.equal(body.name, 'Foo');
    assert.equal(body.description, 'd');
  } finally {
    await cleanup(s);
  }
});

test('POST /api/projects returns 400 if slug missing', async () => {
  const s = setup();
  try {
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'NoSlug' },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await cleanup(s);
  }
});

test('POST /api/projects returns 409 on duplicate', async () => {
  const s = setup();
  try {
    await s.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { slug: 'foo' },
    });
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { slug: 'foo' },
    });
    assert.equal(res.statusCode, 409);
  } finally {
    await cleanup(s);
  }
});

test('GET /api/projects lists projects', async () => {
  const s = setup();
  try {
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'a' } });
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'b' } });
    const res = await s.app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(res.statusCode, 200);
    const list = res.json();
    assert.equal(list.length, 2);
  } finally {
    await cleanup(s);
  }
});

test('GET /api/projects/:slug returns 404 for unknown', async () => {
  const s = setup();
  try {
    const res = await s.app.inject({ method: 'GET', url: '/api/projects/nope' });
    assert.equal(res.statusCode, 404);
  } finally {
    await cleanup(s);
  }
});

test('POST /api/projects/:slug/reviews requires title', async () => {
  const s = setup();
  try {
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'foo' } });
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/projects/foo/reviews',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await cleanup(s);
  }
});

test('POST /api/projects/:slug/reviews creates review', async () => {
  const s = setup();
  try {
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'foo' } });
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/projects/foo/reviews',
      payload: {
        title: '登录页 UI 还原',
        pushedBy: 'claude-code',
        sessionId: 'sess-test',
        tags: ['ui'],
        selfAssessedRisk: 'L2',
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.status, 'pending');
    assert.ok(body.id.startsWith('rv_'));
    assert.equal(body.context.title, '登录页 UI 还原');
  } finally {
    await cleanup(s);
  }
});

test('full lifecycle: push → list → show → decide', async () => {
  const s = setup();
  try {
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'foo' } });

    const pushRes = await s.app.inject({
      method: 'POST',
      url: '/api/projects/foo/reviews',
      payload: { title: 'A', pushedBy: 'x', sessionId: 'sess-test', selfAssessedRisk: 'L1' },
    });
    const review = pushRes.json();

    const listRes = await s.app.inject({
      method: 'GET',
      url: '/api/projects/foo/reviews',
    });
    assert.equal(listRes.json().length, 1);

    const showRes = await s.app.inject({ method: 'GET', url: `/api/reviews/${review.id}` });
    assert.equal(showRes.statusCode, 200);
    assert.equal(showRes.json().id, review.id);

    const decideRes = await s.app.inject({
      method: 'POST',
      url: `/api/reviews/${review.id}/decide`,
      payload: { verdict: 'approve', reviewer: 'alice', comment: 'LGTM' },
    });
    assert.equal(decideRes.statusCode, 200);
    const decided = decideRes.json();
    assert.equal(decided.status, 'decided');
    assert.equal(decided.decision.verdict, 'approve');
    assert.equal(decided.decision.reviewer, 'alice');
  } finally {
    await cleanup(s);
  }
});

test('decide returns 409 on already-decided review', async () => {
  const s = setup();
  try {
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'foo' } });
    const pushRes = await s.app.inject({
      method: 'POST',
      url: '/api/projects/foo/reviews',
      payload: { title: 'A', pushedBy: 'x', sessionId: 'sess-test' },
    });
    const review = pushRes.json();
    await s.app.inject({
      method: 'POST',
      url: `/api/reviews/${review.id}/decide`,
      payload: { verdict: 'approve' },
    });
    const res = await s.app.inject({
      method: 'POST',
      url: `/api/reviews/${review.id}/decide`,
      payload: { verdict: 'reject' },
    });
    assert.equal(res.statusCode, 409);
  } finally {
    await cleanup(s);
  }
});

test('decide returns 400 on invalid verdict', async () => {
  const s = setup();
  try {
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'foo' } });
    const pushRes = await s.app.inject({
      method: 'POST',
      url: '/api/projects/foo/reviews',
      payload: { title: 'A', pushedBy: 'x', sessionId: 'sess-test' },
    });
    const review = pushRes.json();
    const res = await s.app.inject({
      method: 'POST',
      url: `/api/reviews/${review.id}/decide`,
      payload: { verdict: 'maybe' },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await cleanup(s);
  }
});

test('GET /api/reviews/:id returns 404 for unknown', async () => {
  const s = setup();
  try {
    const res = await s.app.inject({ method: 'GET', url: '/api/reviews/rv_nope' });
    assert.equal(res.statusCode, 404);
  } finally {
    await cleanup(s);
  }
});

test('GET /api/reviews/:id?wait=N returns immediately if already decided', async () => {
  const s = setup();
  try {
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'foo' } });
    const pushRes = await s.app.inject({
      method: 'POST',
      url: '/api/projects/foo/reviews',
      payload: { title: 'A', pushedBy: 'x', sessionId: 'sess-test' },
    });
    const review = pushRes.json();
    await s.app.inject({
      method: 'POST',
      url: `/api/reviews/${review.id}/decide`,
      payload: { verdict: 'approve' },
    });
    const res = await s.app.inject({
      method: 'GET',
      url: `/api/reviews/${review.id}?wait=5&interval=50`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'decided');
  } finally {
    await cleanup(s);
  }
});

test('GET /api/reviews/:id?wait=N picks up decision mid-poll', async () => {
  const s = setup();
  try {
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'foo' } });
    const pushRes = await s.app.inject({
      method: 'POST',
      url: '/api/projects/foo/reviews',
      payload: { title: 'A', pushedBy: 'x', sessionId: 'sess-test' },
    });
    const review = pushRes.json();

    const waitPromise = s.app.inject({
      method: 'GET',
      url: `/api/reviews/${review.id}?wait=5&interval=50`,
    });

    setTimeout(
      () =>
        s.app.inject({
          method: 'POST',
          url: `/api/reviews/${review.id}/decide`,
          payload: { verdict: 'reject', reviewer: 'late' },
        }),
      150
    );

    const start = Date.now();
    const res = await waitPromise;
    const elapsed = Date.now() - start;

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'decided');
    assert.equal(body.decision.reviewer, 'late');
    assert.ok(elapsed < 1000, `should resolve fast, took ${elapsed}ms`);
  } finally {
    await cleanup(s);
  }
});

test('GET /api/reviews/:id?wait=N returns 408 on timeout', async () => {
  const s = setup();
  try {
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'foo' } });
    const pushRes = await s.app.inject({
      method: 'POST',
      url: '/api/projects/foo/reviews',
      payload: { title: 'A', pushedBy: 'x', sessionId: 'sess-test' },
    });
    const review = pushRes.json();

    const res = await s.app.inject({
      method: 'GET',
      url: `/api/reviews/${review.id}?wait=1&interval=50`,
    });
    assert.equal(res.statusCode, 408);
  } finally {
    await cleanup(s);
  }
});

test('POST /api/projects/:slug/reviews requires sessionId', async () => {
  const s = setup();
  try {
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'foo' } });
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/projects/foo/reviews',
      payload: { title: 'A', pushedBy: 'x' },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await cleanup(s);
  }
});

test('POST /api/reviews/:id/resume returns 404 for unknown id', async () => {
  const s = setup();
  try {
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/reviews/rv_nope/resume',
      payload: { question: 'why?' },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await cleanup(s);
  }
});

test('POST /api/reviews/:id/resume returns 400 when question missing', async () => {
  const s = setup();
  try {
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'foo' } });
    const pushRes = await s.app.inject({
      method: 'POST',
      url: '/api/projects/foo/reviews',
      payload: { title: 'A', pushedBy: 'x', sessionId: 'sess-test' },
    });
    const review = pushRes.json();
    const res = await s.app.inject({
      method: 'POST',
      url: `/api/reviews/${review.id}/resume`,
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await cleanup(s);
  }
});

test('POST /api/reviews/:id/resume returns 409 when no review session', async () => {
  const s = setup();
  try {
    await s.app.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'foo' } });
    const pushRes = await s.app.inject({
      method: 'POST',
      url: '/api/projects/foo/reviews',
      payload: { title: 'A', pushedBy: 'x', sessionId: 'sess-test' },
    });
    const review = pushRes.json();
    const res = await s.app.inject({
      method: 'POST',
      url: `/api/reviews/${review.id}/resume`,
      payload: { question: 'why?' },
    });
    assert.equal(res.statusCode, 409);
  } finally {
    await cleanup(s);
  }
});