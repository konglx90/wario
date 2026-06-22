import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  decideReview,
  listReviews,
  pushReview,
  ProjectNotFoundError,
  ReviewAlreadyDecidedError,
  ReviewNotFoundError,
  showReview,
  waitForDecision,
} from '../domain/review.js';
import { getProjectBySlug } from '../domain/project.js';
import type { PushReviewInput, ReviewStatus, Verdict } from '../shared/types.js';
import {
  isPrereviewEnabled,
  runPreReview,
  runOcrReview,
  isOcrEnabled,
  resumeReview,
  NoReviewSessionError,
} from '../prereview/index.js';

interface ListQuery {
  status?: string;
  limit?: string;
}

interface DecideBody {
  verdict?: Verdict;
  comment?: string;
  reviewer?: string;
}

interface ResumeBody {
  question?: string;
}

const VALID_STATUSES = new Set<ReviewStatus>(['pending', 'decided']);
const VALID_VERDICTS = new Set<Verdict>(['approve', 'reject', 'comment']);

export function registerReviewRoutes(
  app: FastifyInstance,
  db: Database.Database
): void {
  app.post<{ Params: { slug: string } }>(
    '/api/projects/:slug/reviews',
    async (req, reply) => {
      const body = (req.body ?? {}) as PushReviewInput;
      if (!body.title || typeof body.title !== 'string') {
        return reply.code(400).send({ error: 'title is required' });
      }
      if (!body.sessionId || typeof body.sessionId !== 'string') {
        return reply.code(400).send({ error: 'sessionId is required' });
      }
      const input: PushReviewInput = {
        projectSlug: req.params.slug,
        pushedBy: body.pushedBy ?? 'anonymous',
        sessionId: body.sessionId,
        title: body.title,
        description: body.description,
        diff: body.diff,
        tags: body.tags,
        source: body.source,
        sourceRef: body.sourceRef,
        repoPath: body.repoPath,
        gitFrom: body.gitFrom,
        gitTo: body.gitTo,
        selfAssessedRisk: body.selfAssessedRisk,
        contentType: body.contentType,
      };
      try {
        const review = pushReview(db, input);

        if (isPrereviewEnabled()) {
          void runPreReview(db, review);
        }

        if (isOcrEnabled()) {
          void runOcrReview(db, review);
        }

        return reply.code(201).send(review);
      } catch (e) {
        if (e instanceof ProjectNotFoundError) {
          return reply.code(404).send({ error: e.message });
        }
        throw e;
      }
    }
  );

  app.get<{ Params: { slug: string }; Querystring: ListQuery }>(
    '/api/projects/:slug/reviews',
    async (req, reply) => {
      const project = getProjectBySlug(db, req.params.slug);
      if (!project) {
        return reply.code(404).send({ error: `Project not found: ${req.params.slug}` });
      }
      let status: ReviewStatus | undefined;
      if (req.query.status) {
        if (!VALID_STATUSES.has(req.query.status as ReviewStatus)) {
          return reply.code(400).send({ error: `invalid status: ${req.query.status}` });
        }
        status = req.query.status as ReviewStatus;
      }
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
      const reviews = listReviews(db, {
        projectSlug: req.params.slug,
        status,
        limit,
      });
      return reply.send(reviews);
    }
  );

  app.get<{ Params: { id: string }; Querystring: { wait?: string; interval?: string } }>(
    '/api/reviews/:id',
    async (req, reply) => {
      const id = req.params.id;
      const waitSec = req.query.wait ? parseInt(req.query.wait, 10) : 0;
      const intervalMs = req.query.interval ? parseInt(req.query.interval, 10) : 1000;
      if (waitSec > 0) {
        const result = await waitForDecision(db, id, waitSec, intervalMs);
        if (result.outcome === 'notfound') {
          return reply.code(404).send({ error: `Review not found: ${id}` });
        }
        if (result.outcome === 'timeout') {
          return reply.code(408).send({
            error: `timeout: review ${id} not decided within ${waitSec}s`,
            reviewId: id,
          });
        }
        return reply.send(result.review);
      }
      const review = showReview(db, id);
      if (!review) {
        return reply.code(404).send({ error: `Review not found: ${id}` });
      }
      return reply.send(review);
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/reviews/:id/decide',
    async (req, reply) => {
      const body = (req.body ?? {}) as DecideBody;
      if (!body.verdict || !VALID_VERDICTS.has(body.verdict)) {
        return reply.code(400).send({
          error: `verdict must be one of: approve | reject | comment`,
        });
      }
      try {
        const reviewer = body.reviewer ?? process.env.USER ?? 'anonymous';
        const review = decideReview(db, {
          reviewId: req.params.id,
          verdict: body.verdict,
          comment: body.comment,
          reviewer,
        });
        return reply.send(review);
      } catch (e) {
        if (e instanceof ReviewNotFoundError) {
          return reply.code(404).send({ error: e.message });
        }
        if (e instanceof ReviewAlreadyDecidedError) {
          return reply.code(409).send({ error: e.message });
        }
        throw e;
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/reviews/:id/resume',
    async (req, reply) => {
      const body = (req.body ?? {}) as ResumeBody;
      if (!body.question || typeof body.question !== 'string' || !body.question.trim()) {
        return reply.code(400).send({ error: 'question is required' });
      }
      try {
        const result = await resumeReview(db, req.params.id, body.question.trim());
        return reply.send(result.review);
      } catch (e) {
        if (e instanceof ReviewNotFoundError) {
          return reply.code(404).send({ error: e.message });
        }
        if (e instanceof NoReviewSessionError) {
          return reply.code(409).send({ error: e.message });
        }
        throw e;
      }
    }
  );
}