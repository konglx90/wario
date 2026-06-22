import type { Database } from 'better-sqlite3';

export interface Migration {
  id: number;
  name: string;
  up: (db: Database) => void;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'initial_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          description TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS review_requests (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          pushed_by TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          diff TEXT,
          artifacts TEXT,
          tags TEXT,
          source TEXT,
          source_ref TEXT,
          self_assessed_risk TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          decision TEXT,
          pre_review TEXT,
          created_at TEXT NOT NULL,
          decided_at TEXT,
          FOREIGN KEY (project_id) REFERENCES projects(id)
        );

        CREATE INDEX IF NOT EXISTS idx_review_requests_project_status
          ON review_requests(project_id, status);
        CREATE INDEX IF NOT EXISTS idx_review_requests_created_at
          ON review_requests(created_at);
        CREATE INDEX IF NOT EXISTS idx_review_requests_self_assessed_risk
          ON review_requests(self_assessed_risk);
      `);
    },
  },
  {
    id: 2,
    name: 'add_content_type',
    up: (db) => {
      const cols = db
        .prepare("PRAGMA table_info(review_requests)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'content_type')) {
        db.exec('ALTER TABLE review_requests ADD COLUMN content_type TEXT');
      }
    },
  },
  {
    id: 3,
    name: 'add_session_id',
    up: (db) => {
      const cols = db
        .prepare("PRAGMA table_info(review_requests)")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'session_id')) {
        db.exec('ALTER TABLE review_requests ADD COLUMN session_id TEXT');
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_review_requests_session_id ON review_requests(session_id)'
      );
    },
  },
  {
    id: 4,
    name: 'add_review_session_id_and_drop_artifacts',
    up: (db) => {
      const cols = db
        .prepare("PRAGMA table_info(review_requests)")
        .all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));

      if (!colNames.has('review_session_id')) {
        db.exec('ALTER TABLE review_requests ADD COLUMN review_session_id TEXT');
      }
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_review_requests_review_session_id ON review_requests(review_session_id)'
      );

      db.exec(
        'DROP INDEX IF EXISTS idx_review_requests_self_assessed_risk'
      );

      if (colNames.has('artifacts')) {
        db.exec('ALTER TABLE review_requests DROP COLUMN artifacts');
      }
    },
  },
];