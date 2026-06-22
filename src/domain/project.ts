import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Project } from '../shared/types.js';

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectAlreadyExistsError extends Error {
  constructor(slug: string) {
    super(`Project already exists: ${slug}`);
    this.name = 'ProjectAlreadyExistsError';
  }
}

export function createProject(
  db: Database.Database,
  input: { slug: string; name: string; description?: string }
): Project {
  const existing = getProjectBySlug(db, input.slug);
  if (existing) throw new ProjectAlreadyExistsError(input.slug);

  const now = new Date().toISOString();
  const id = `p_${randomUUID()}`;
  db.prepare(`
    INSERT INTO projects (id, slug, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.slug, input.name, input.description ?? null, now, now);
  return {
    id,
    slug: input.slug,
    name: input.name,
    description: input.description,
    createdAt: now,
    updatedAt: now,
  };
}

export function getProjectBySlug(
  db: Database.Database,
  slug: string
): Project | undefined {
  const row = db
    .prepare('SELECT * FROM projects WHERE slug = ?')
    .get(slug) as ProjectRow | undefined;
  return row ? rowToProject(row) : undefined;
}

export function getProjectById(
  db: Database.Database,
  id: string
): Project | undefined {
  const row = db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as ProjectRow | undefined;
  return row ? rowToProject(row) : undefined;
}

export function listProjects(db: Database.Database): Project[] {
  const rows = db
    .prepare('SELECT * FROM projects ORDER BY created_at ASC')
    .all() as ProjectRow[];
  return rows.map(rowToProject);
}

export function ensureDefaultProject(db: Database.Database): Project {
  const existing = getProjectBySlug(db, 'default');
  if (existing) return existing;
  return createProject(db, {
    slug: 'default',
    name: 'Default Project',
    description: 'Auto-created default project. Use `wario project create <slug>` to add more.',
  });
}