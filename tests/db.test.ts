import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/index.js';
import {
  createProject,
  ensureDefaultProject,
  getProjectBySlug,
  listProjects,
  ProjectAlreadyExistsError,
} from '../src/domain/project.js';

function tempDb(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wario-db-'));
  return { path: join(dir, 'data.db'), dir };
}

function cleanup(path: string, dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test('migrations are idempotent (running twice does not throw)', () => {
  const { path, dir } = tempDb();
  try {
    const db1 = openDatabase(path);
    db1.close();
    const db2 = openDatabase(path);
    db2.close();
  } finally {
    cleanup(path, dir);
  }
});

test('createProject + getProjectBySlug roundtrip', () => {
  const { path, dir } = tempDb();
  const db = openDatabase(path);
  try {
    const project = createProject(db, { slug: 'foo', name: 'Foo' });
    assert.ok(project.id.startsWith('p_'));
    assert.equal(project.slug, 'foo');
    assert.equal(project.name, 'Foo');

    const fetched = getProjectBySlug(db, 'foo');
    assert.ok(fetched);
    assert.equal(fetched.id, project.id);
    assert.equal(fetched.createdAt, project.createdAt);

    const missing = getProjectBySlug(db, 'nope');
    assert.equal(missing, undefined);
  } finally {
    db.close();
    cleanup(path, dir);
  }
});

test('createProject throws on duplicate slug', () => {
  const { path, dir } = tempDb();
  const db = openDatabase(path);
  try {
    createProject(db, { slug: 'foo', name: 'Foo' });
    assert.throws(
      () => createProject(db, { slug: 'foo', name: 'Foo2' }),
      ProjectAlreadyExistsError
    );
  } finally {
    db.close();
    cleanup(path, dir);
  }
});

test('listProjects returns in created_at ASC order', () => {
  const { path, dir } = tempDb();
  const db = openDatabase(path);
  try {
    createProject(db, { slug: 'a', name: 'A' });
    createProject(db, { slug: 'b', name: 'B' });
    createProject(db, { slug: 'c', name: 'C' });
    const list = listProjects(db);
    assert.equal(list.length, 3);
    assert.equal(list[0].slug, 'a');
    assert.equal(list[1].slug, 'b');
    assert.equal(list[2].slug, 'c');
  } finally {
    db.close();
    cleanup(path, dir);
  }
});

test('ensureDefaultProject is idempotent', () => {
  const { path, dir } = tempDb();
  const db = openDatabase(path);
  try {
    const first = ensureDefaultProject(db);
    const second = ensureDefaultProject(db);
    assert.equal(first.id, second.id);
    assert.equal(first.slug, 'default');
  } finally {
    db.close();
    cleanup(path, dir);
  }
});

test('foreign key constraint blocks orphan review', () => {
  const { path, dir } = tempDb();
  const db = openDatabase(path);
  try {
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO review_requests (id, project_id, pushed_by, title, status, created_at)
             VALUES ('rv_x', 'p_does_not_exist', 'x', 't', 'pending', '2026-01-01')`
          )
          .run(),
      /FOREIGN KEY constraint failed/
    );
  } finally {
    db.close();
    cleanup(path, dir);
  }
});