import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createProject } from '../src/domain/project.js';
import { pushReview } from '../src/domain/review.js';
import {
  resumeReview,
  ReviewNotFoundError,
  NoReviewSessionError,
} from '../src/prereview/index.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wario-rs-'));
  const path = join(dir, 'data.db');
  const db = openDatabase(path);
  return { db, dir, path };
}

function cleanup(db: any, dir: string) {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

test('resumeReview throws ReviewNotFoundError for unknown id', async () => {
  const { db, dir } = setup();
  try {
    await assert.rejects(
      () => resumeReview(db, 'rv_does_not_exist', 'why?'),
      ReviewNotFoundError
    );
  } finally {
    cleanup(db, dir);
  }
});

test('resumeReview throws NoReviewSessionError when preReview is missing', async () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    const r = pushReview(db, {
      projectSlug: 'p1',
      pushedBy: 'x',
      sessionId: 's1',
      title: 'A',
    });
    await assert.rejects(
      () => resumeReview(db, r.id, 'why?'),
      NoReviewSessionError
    );
  } finally {
    cleanup(db, dir);
  }
});

test('resumeReview throws NoReviewSessionError when reviewSessionId is empty', async () => {
  const { db, dir } = setup();
  try {
    createProject(db, { slug: 'p1', name: 'P1' });
    const r = pushReview(db, {
      projectSlug: 'p1',
      pushedBy: 'x',
      sessionId: 's1',
      title: 'A',
    });
    // Manually write a pre_review with empty reviewSessionId (simulates parse failure)
    const fakeReport = {
      byAgent: 'codex',
      reviewSessionId: '',
      riskLevel: 'L2',
      summary: 'ok',
      findings: [],
      createdAt: new Date().toISOString(),
    };
    db.prepare('UPDATE review_requests SET pre_review = ? WHERE id = ?').run(
      JSON.stringify(fakeReport),
      r.id
    );
    await assert.rejects(
      () => resumeReview(db, r.id, 'why?'),
      NoReviewSessionError
    );
  } finally {
    cleanup(db, dir);
  }
});