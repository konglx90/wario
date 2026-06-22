import { spawn } from 'node:child_process';
import type Database from 'better-sqlite3';
import type {
  ContentType,
  ReviewRequest,
  RiskFinding,
  RiskLevel,
  RiskReport,
} from '../shared/types.js';

const OCR_CMD = process.env.WARIO_OCR_CMD ?? 'ocr';
const OCR_TIMEOUT_MS =
  parseInt(process.env.WARIO_OCR_TIMEOUT ?? '300', 10) * 1000;
const OCR_MODEL = process.env.WARIO_OCR_MODEL;

export function isOcrEnabled(): boolean {
  return process.env.WARIO_OCR === 'enabled';
}

interface OcrLlmComment {
  path?: string;
  content?: string;
  suggestion_code?: string;
  existing_code?: string;
  start_line?: number;
  end_line?: number;
  thinking?: string;
}

interface OcrJsonOutput {
  status?: string;
  message?: string;
  summary?: {
    files_reviewed?: number;
    comments?: number;
    total_tokens?: number;
    elapsed?: string;
  };
  comments?: OcrLlmComment[];
  warnings?: unknown[];
}

export interface OcrRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

function spawnOcr(
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<OcrRunnerResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let timedOut = false;
    const child = spawn(OCR_CMD, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

export function parseOcrOutput(stdout: string): OcrJsonOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as OcrJsonOutput;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]) as OcrJsonOutput;
    } catch {
      return undefined;
    }
  }
}

export function mapOcrToRiskReport(parsed: OcrJsonOutput): RiskReport {
  const rawComments = Array.isArray(parsed.comments) ? parsed.comments : [];
  const filesReviewed = new Set<string>();

  const findings: RiskFinding[] = [];
  for (const c of rawComments) {
    if (!c || typeof c !== 'object') continue;
    const path = typeof c.path === 'string' ? c.path : '';
    const content = typeof c.content === 'string' ? c.content : '';
    if (!content) continue;
    if (path) filesReviewed.add(path);

    const startLine = typeof c.start_line === 'number' ? c.start_line : 0;
    const endLine = typeof c.end_line === 'number' ? c.end_line : startLine;
    const location =
      path && startLine > 0
        ? endLine > startLine
          ? `${path}:${startLine}-${endLine}`
          : `${path}:${startLine}`
        : path || undefined;

    findings.push({
      severity: 'medium',
      category: 'ocr',
      description: content,
      location,
      suggestion:
        typeof c.suggestion_code === 'string' && c.suggestion_code.trim()
          ? c.suggestion_code
          : undefined,
    });
  }

  const riskLevel = deriveRiskLevel(findings.length);
  const status = parsed.status ?? 'unknown';
  const fileCount = filesReviewed.size;
  const summary = `OCR found ${findings.length} comment${
    findings.length === 1 ? '' : 's'
  } across ${fileCount} file${fileCount === 1 ? '' : 's'}. (status: ${status})`;

  return {
    byAgent: 'ocr',
    reviewSessionId: '',
    riskLevel,
    summary,
    findings,
    createdAt: new Date().toISOString(),
  };
}

function deriveRiskLevel(findingCount: number): RiskLevel {
  if (findingCount === 0) return 'L1';
  if (findingCount <= 2) return 'L2';
  return 'L3';
}

export async function runOcrReview(
  db: Database.Database,
  review: ReviewRequest
): Promise<void> {
  try {
    if (!isOcrEnabled()) return;

    const contentType = review.contentType ?? 'code';
    if (contentType !== 'code') return;

    const repoPath = review.context.repoPath;
    const gitFrom = review.context.gitFrom;
    const gitTo = review.context.gitTo;
    if (!repoPath || !gitFrom || !gitTo) {
      console.warn(
        `[ocr] skip ${review.id}: missing repoPath/gitFrom/gitTo`
      );
      return;
    }

    db.prepare(
      `UPDATE review_requests SET ocr_status = 'running' WHERE id = ?`
    ).run(review.id);

    const args = [
      'review',
      '--repo',
      repoPath,
      '--from',
      gitFrom,
      '--to',
      gitTo,
      '--format',
      'json',
      '--audience',
      'agent',
    ];
    if (OCR_MODEL) {
      args.push('--model', OCR_MODEL);
    }

    const result = await spawnOcr(args, repoPath, OCR_TIMEOUT_MS);

    if (result.timedOut) {
      db.prepare(
        `UPDATE review_requests SET ocr_status = 'timeout' WHERE id = ?`
      ).run(review.id);
      console.warn(
        `[ocr] ${OCR_CMD} timed out after ${OCR_TIMEOUT_MS}ms for ${review.id}`
      );
      return;
    }

    if (result.exitCode !== 0) {
      db.prepare(
        `UPDATE review_requests SET ocr_status = 'failed' WHERE id = ?`
      ).run(review.id);
      console.warn(
        `[ocr] ${OCR_CMD} exited ${result.exitCode} for ${review.id}: ${result.stderr.slice(0, 200)}`
      );
      return;
    }

    const parsed = parseOcrOutput(result.stdout);
    if (!parsed) {
      db.prepare(
        `UPDATE review_requests SET ocr_status = 'failed' WHERE id = ?`
      ).run(review.id);
      console.warn(
        `[ocr] output not parseable for ${review.id} (stdout: ${result.stdout.slice(0, 200)})`
      );
      return;
    }

    const report = mapOcrToRiskReport(parsed);

    db.prepare(
      'UPDATE review_requests SET ocr_review = ?, ocr_status = ? WHERE id = ?'
    ).run(JSON.stringify(report), 'succeeded', review.id);

    console.log(
      `[ocr] ${review.id} reviewed by ocr (${result.durationMs}ms, ${report.findings.length} findings, risk=${report.riskLevel})`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare(
      `UPDATE review_requests SET ocr_status = 'failed' WHERE id = ?`
    ).run(review.id);
    console.warn(`[ocr] unexpected error for ${review.id}: ${msg}`);
  }
}
