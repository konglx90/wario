import type Database from 'better-sqlite3';
import type { ReviewRequest, RiskReport } from '../shared/types.js';
import { detectProducer, pickReviewer } from './router.js';
import { buildPrompt } from './prompts.js';
import { parseRiskReport, runReviewerCli } from './runner.js';
import { runOcrReview, isOcrEnabled } from './ocr.js';
import { ReviewNotFoundError } from '../domain/review.js';

export { ReviewNotFoundError };
export { runOcrReview, isOcrEnabled };

type SpawnReviewer = 'claude' | 'codex';

const REVIEWER_CMDS: Record<SpawnReviewer, string> = {
  claude: process.env.WARIO_CLAUDE_CMD ?? 'claude',
  codex: process.env.WARIO_CODEX_CMD ?? 'codex',
};

const DEFAULT_REVIEWER: SpawnReviewer =
  (process.env.WARIO_DEFAULT_REVIEWER as SpawnReviewer) ?? 'claude';

const TIMEOUT_MS = parseInt(process.env.WARIO_PREREVIEW_TIMEOUT ?? '120', 10) * 1000;

export function isPrereviewEnabled(): boolean {
  return process.env.WARIO_PREREVIEW !== 'disabled';
}

function resolveReviewer(producer: ReturnType<typeof detectProducer>): SpawnReviewer {
  const routing = pickReviewer(producer, DEFAULT_REVIEWER);
  if (routing.reviewer === 'default') return DEFAULT_REVIEWER;
  return routing.reviewer;
}

function splitCommand(cmd: string): { command: string; baseArgs: string[] } {
  const trimmed = cmd.trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx < 0) return { command: trimmed, baseArgs: [] };
  return {
    command: trimmed.slice(0, spaceIdx),
    baseArgs: trimmed.slice(spaceIdx + 1).split(/\s+/).filter(Boolean),
  };
}

export async function runPreReview(
  db: Database.Database,
  review: ReviewRequest
): Promise<void> {
  let reviewer: 'claude' | 'codex' | undefined;
  try {
    const producer = detectProducer(review.context.source, review.pushedBy);
    reviewer = resolveReviewer(producer);
    db.prepare(
      `UPDATE review_requests SET attempted_reviewer = ?, prereview_status = 'running' WHERE id = ?`
    ).run(reviewer, review.id);

    const { command, baseArgs } = splitCommand(REVIEWER_CMDS[reviewer]);

    const prompt = buildPrompt({
      projectSlug: '',
      pushedBy: review.pushedBy,
      sessionId: review.sessionId,
      title: review.context.title,
      description: review.context.description,
      diff: review.context.diff,
      tags: review.context.tags,
      source: review.context.source,
      sourceRef: review.context.sourceRef,
      selfAssessedRisk: review.selfAssessedRisk,
      contentType: review.contentType,
    });

    const result = await runReviewerCli(
      reviewer,
      { command, baseArgs, timeoutMs: TIMEOUT_MS },
      prompt
    );

    if (result.timedOut) {
      db.prepare(
        `UPDATE review_requests SET prereview_status = 'timeout' WHERE id = ?`
      ).run(review.id);
      console.warn(
        `[prereview] ${command} timed out after ${TIMEOUT_MS}ms for ${review.id}`
      );
      return;
    }

    if (result.exitCode !== 0) {
      db.prepare(
        `UPDATE review_requests SET prereview_status = 'failed' WHERE id = ?`
      ).run(review.id);
      console.warn(
        `[prereview] ${command} exited ${result.exitCode} for ${review.id}: ${result.stderr.slice(0, 200)}`
      );
      return;
    }

    const report = parseRiskReport(result.modelText);
    if (!report) {
      db.prepare(
        `UPDATE review_requests SET prereview_status = 'failed' WHERE id = ?`
      ).run(review.id);
      console.warn(
        `[prereview] ${command} output not parseable for ${review.id} (modelText: ${result.modelText.slice(0, 200)})`
      );
      return;
    }

    const finalReport: RiskReport = {
      ...report,
      byAgent: reviewer,
      reviewSessionId: result.sessionId ?? '',
      createdAt: new Date().toISOString(),
    };

    db.prepare(
      `UPDATE review_requests SET pre_review = ?, review_session_id = ?, prereview_status = 'succeeded' WHERE id = ?`
    ).run(JSON.stringify(finalReport), finalReport.reviewSessionId, review.id);

    console.log(
      `[prereview] ${review.id} reviewed by ${reviewer} (${result.durationMs}ms, ${report.findings.length} findings, risk=${report.riskLevel}, session=${finalReport.reviewSessionId})`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare(
      `UPDATE review_requests SET prereview_status = 'failed' WHERE id = ?`
    ).run(review.id);
    console.warn(`[prereview] unexpected error for ${review.id}: ${msg}`);
  }
}

export async function resumeReview(
  db: Database.Database,
  reviewId: string,
  question: string
): Promise<{ review: ReviewRequest; round: RiskReport['resumeRounds'] extends (infer T)[] | undefined ? T : unknown }> {
  const row = db
    .prepare('SELECT pre_review, review_session_id FROM review_requests WHERE id = ?')
    .get(reviewId) as
    | { pre_review: string | null; review_session_id: string | null }
    | undefined;

  if (!row) {
    throw new ReviewNotFoundError(reviewId);
  }

  if (!row.pre_review) {
    throw new NoReviewSessionError(reviewId);
  }

  const existing: RiskReport = JSON.parse(row.pre_review);
  const sessionId = row.review_session_id ?? existing.reviewSessionId;
  if (!sessionId) {
    throw new NoReviewSessionError(reviewId);
  }

  const reviewer = existing.byAgent;
  if (reviewer !== 'claude' && reviewer !== 'codex') {
    throw new NoReviewSessionError(reviewId);
  }
  const { command, baseArgs } = splitCommand(REVIEWER_CMDS[reviewer]);

  const result = await runReviewerCli(
    reviewer,
    { command, baseArgs, timeoutMs: TIMEOUT_MS, resumeSessionId: sessionId },
    question
  );

  const text = result.modelText;
  const newFindingsRaw = parseRiskReport(text);
  const round = {
    question,
    answer: text,
    findings: newFindingsRaw?.findings,
    at: new Date().toISOString(),
  };

  const rounds = [...(existing.resumeRounds ?? []), round];
  const updated: RiskReport = { ...existing, resumeRounds: rounds };
  db.prepare(
    'UPDATE review_requests SET pre_review = ? WHERE id = ?'
  ).run(JSON.stringify(updated), reviewId);

  const review = fetchReview(db, reviewId);
  return { review, round };
}

function fetchReview(db: Database.Database, reviewId: string): ReviewRequest {
  const row = db
    .prepare('SELECT * FROM review_requests WHERE id = ?')
    .get(reviewId) as any;
  return deserializeReview(row);
}

function deserializeReview(row: any): ReviewRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    pushedBy: row.pushed_by,
    sessionId: row.session_id,
    context: {
      title: row.title,
      description: row.description ?? undefined,
      diff: row.diff ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      source: row.source ?? undefined,
      sourceRef: row.source_ref ?? undefined,
    },
    selfAssessedRisk: row.self_assessed_risk ?? undefined,
    contentType: row.content_type ?? undefined,
    status: row.status,
    preReview: row.pre_review ? JSON.parse(row.pre_review) : undefined,
    reviewSessionId: row.review_session_id ?? undefined,
    decision: row.decision ? JSON.parse(row.decision) : undefined,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
  };
}

export class NoReviewSessionError extends Error {
  constructor(id: string) {
    super(`Review ${id} has no review session to resume`);
    this.name = 'NoReviewSessionError';
  }
}