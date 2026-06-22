import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  ContentType,
  DecideReviewInput,
  ListReviewFilter,
  PushReviewInput,
  ReviewDecision,
  ReviewRequest,
  ReviewStatus,
  RiskLevel,
  RiskReport,
} from '../shared/types.js';
import { getProjectBySlug } from './project.js';

interface ReviewRow {
  id: string;
  project_id: string;
  pushed_by: string;
  session_id: string | null;
  title: string;
  description: string | null;
  diff: string | null;
  tags: string | null;
  source: string | null;
  source_ref: string | null;
  self_assessed_risk: string | null;
  content_type: string | null;
  status: string;
  decision: string | null;
  pre_review: string | null;
  ocr_review: string | null;
  attempted_reviewer: string | null;
  prereview_status: string | null;
  ocr_status: string | null;
  review_session_id: string | null;
  created_at: string;
  decided_at: string | null;
}

function rowToReview(row: ReviewRow): ReviewRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    pushedBy: row.pushed_by,
    sessionId: row.session_id ?? '',
    context: {
      title: row.title,
      description: row.description ?? undefined,
      diff: row.diff ?? undefined,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
      source: row.source ?? undefined,
      sourceRef: row.source_ref ?? undefined,
    },
    selfAssessedRisk: (row.self_assessed_risk as RiskLevel | null) ?? undefined,
    contentType: (row.content_type as ContentType | null) ?? undefined,
    status: row.status as ReviewStatus,
    decision: row.decision ? (JSON.parse(row.decision) as ReviewDecision) : undefined,
    preReview: row.pre_review ? (JSON.parse(row.pre_review) as RiskReport) : undefined,
    ocrReview: row.ocr_review ? (JSON.parse(row.ocr_review) as RiskReport) : undefined,
    attemptedReviewer: (row.attempted_reviewer as ReviewRequest['attemptedReviewer'] | null) ?? undefined,
    preReviewStatus: (row.prereview_status as ReviewRequest['preReviewStatus'] | null) ?? undefined,
    ocrStatus: (row.ocr_status as ReviewRequest['ocrStatus'] | null) ?? undefined,
    reviewSessionId: row.review_session_id ?? undefined,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
  };
}

export class ProjectNotFoundError extends Error {
  constructor(slug: string) {
    super(`Project not found: ${slug}`);
    this.name = 'ProjectNotFoundError';
  }
}

export class ReviewNotFoundError extends Error {
  constructor(id: string) {
    super(`Review not found: ${id}`);
    this.name = 'ReviewNotFoundError';
  }
}

export class ReviewAlreadyDecidedError extends Error {
  constructor(id: string) {
    super(`Review already decided: ${id}`);
    this.name = 'ReviewAlreadyDecidedError';
  }
}

export function pushReview(
  db: Database.Database,
  input: PushReviewInput
): ReviewRequest {
  const project = getProjectBySlug(db, input.projectSlug);
  if (!project) throw new ProjectNotFoundError(input.projectSlug);

  const now = new Date().toISOString();
  const id = `rv_${randomUUID()}`;

  db.prepare(`
    INSERT INTO review_requests (
      id, project_id, pushed_by, session_id, title, description, diff, tags,
      source, source_ref, self_assessed_risk, content_type, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    project.id,
    input.pushedBy,
    input.sessionId,
    input.title,
    input.description ?? null,
    input.diff ?? null,
    input.tags ? JSON.stringify(input.tags) : null,
    input.source ?? null,
    input.sourceRef ?? null,
    input.selfAssessedRisk ?? null,
    input.contentType ?? null,
    'pending',
    now
  );

  return {
    id,
    projectId: project.id,
    pushedBy: input.pushedBy,
    sessionId: input.sessionId,
    context: {
      title: input.title,
      description: input.description,
      diff: input.diff,
      tags: input.tags,
      source: input.source,
      sourceRef: input.sourceRef,
      repoPath: input.repoPath,
      gitFrom: input.gitFrom,
      gitTo: input.gitTo,
    },
    selfAssessedRisk: input.selfAssessedRisk,
    contentType: input.contentType,
    status: 'pending',
    createdAt: now,
  };
}

export function listReviews(
  db: Database.Database,
  filter: ListReviewFilter
): ReviewRequest[] {
  let sql = `
    SELECT rr.* FROM review_requests rr
    INNER JOIN projects p ON p.id = rr.project_id
    WHERE p.slug = ?
  `;
  const params: unknown[] = [filter.projectSlug];

  if (filter.status) {
    sql += ' AND rr.status = ?';
    params.push(filter.status);
  }

  sql += ' ORDER BY rr.created_at DESC LIMIT ?';
  params.push(filter.limit ?? 50);

  const rows = db.prepare(sql).all(...params) as ReviewRow[];
  return rows.map(rowToReview);
}

export function showReview(
  db: Database.Database,
  id: string
): ReviewRequest | undefined {
  const row = db
    .prepare('SELECT * FROM review_requests WHERE id = ?')
    .get(id) as ReviewRow | undefined;
  return row ? rowToReview(row) : undefined;
}

export function decideReview(
  db: Database.Database,
  input: DecideReviewInput
): ReviewRequest {
  const existing = showReview(db, input.reviewId);
  if (!existing) throw new ReviewNotFoundError(input.reviewId);
  if (existing.status === 'decided') {
    throw new ReviewAlreadyDecidedError(input.reviewId);
  }

  const now = new Date().toISOString();
  const decision: ReviewDecision = {
    reviewer: input.reviewer,
    verdict: input.verdict,
    comment: input.comment,
    decidedAt: now,
  };

  db.prepare(`
    UPDATE review_requests
    SET status = 'decided', decision = ?, decided_at = ?
    WHERE id = ?
  `).run(JSON.stringify(decision), now, input.reviewId);

  return {
    ...existing,
    status: 'decided',
    decision,
    decidedAt: now,
  };
}

export type WaitOutcome = 'decided' | 'timeout' | 'notfound';

export interface WaitResult {
  outcome: WaitOutcome;
  review?: ReviewRequest;
}

export async function waitForDecision(
  db: Database.Database,
  id: string,
  timeoutSec: number,
  intervalMs = 1000
): Promise<WaitResult> {
  if (timeoutSec <= 0) {
    const review = showReview(db, id);
    if (!review) return { outcome: 'notfound' };
    return review.status === 'decided'
      ? { outcome: 'decided', review }
      : { outcome: 'timeout' };
  }
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const review = showReview(db, id);
    if (!review) return { outcome: 'notfound' };
    if (review.status === 'decided') return { outcome: 'decided', review };
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
  return { outcome: 'timeout' };
}