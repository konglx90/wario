import { spawn } from 'node:child_process';
import type { RiskReport, RiskFinding, ReviewerKind } from '../shared/types.js';

export interface RunnerConfig {
  command: string;
  baseArgs: string[];
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunnerResult {
  modelText: string;
  sessionId?: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export function runReviewerCli(
  kind: ReviewerKind,
  config: RunnerConfig,
  prompt: string
): Promise<RunnerResult> {
  if (kind === 'claude') {
    return runClaude(config, prompt);
  }
  return runCodex(config, prompt);
}

function runClaude(config: RunnerConfig, prompt: string): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let timedOut = false;
    const args = [...config.baseArgs, '-p', '--output-format', 'json', prompt];
    const child = spawn(config.command, args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, config.timeoutMs);

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
      const parsed = parseClaudeOutput(stdout);
      resolve({
        modelText: parsed.modelText,
        sessionId: parsed.sessionId,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

export function parseClaudeOutput(stdout: string): {
  modelText: string;
  sessionId?: string;
} {
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { modelText: stdout };
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const modelText = typeof parsed.result === 'string' ? parsed.result : '';
    const sessionId =
      typeof parsed.session_id === 'string' ? parsed.session_id : undefined;
    return { modelText, sessionId };
  } catch {
    return { modelText: stdout };
  }
}

function runCodex(config: RunnerConfig, prompt: string): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let timedOut = false;
    const args = [...config.baseArgs, 'exec', '--json', '--skip-git-repo-check', prompt];
    const child = spawn(config.command, args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, config.timeoutMs);

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
      const parsed = parseCodexOutput(stdout);
      resolve({
        modelText: parsed.modelText,
        sessionId: parsed.sessionId,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

export function parseCodexOutput(stdout: string): {
  modelText: string;
  sessionId?: string;
} {
  const lines = stdout.split('\n').filter(Boolean);
  let modelText = '';
  let sessionId: string | undefined;
  for (const line of lines) {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
      sessionId = evt.thread_id;
    } else if (evt.type === 'item.completed') {
      const item = (evt.item as Record<string, unknown> | undefined) ?? {};
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        modelText += item.text;
      }
    }
  }
  return { modelText, sessionId };
}

const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

export function parseRiskReport(modelText: string): RiskReport | undefined {
  const jsonMatch = modelText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return undefined;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.riskLevel !== 'string') return undefined;
    if (typeof parsed.summary !== 'string') return undefined;
    if (!Array.isArray(parsed.findings)) return undefined;

    const validLevels = new Set(['L1', 'L2', 'L3']);
    if (!validLevels.has(parsed.riskLevel)) return undefined;

    const findings: RiskFinding[] = parsed.findings
      .filter(
        (f: unknown) =>
          typeof f === 'object' &&
          f !== null &&
          typeof (f as any).severity === 'string' &&
          VALID_SEVERITIES.has((f as any).severity) &&
          typeof (f as any).category === 'string' &&
          typeof (f as any).description === 'string'
      )
      .map((f: any) => ({
        severity: f.severity,
        category: f.category,
        description: f.description,
        location: typeof f.location === 'string' ? f.location : undefined,
        suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined,
      }));

    return {
      byAgent: 'claude',
      reviewSessionId: '',
      riskLevel: parsed.riskLevel as RiskReport['riskLevel'],
      summary: parsed.summary,
      findings,
      createdAt: new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}