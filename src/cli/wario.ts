#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../db/index.js';
import {
  createProject,
  ensureDefaultProject,
  getProjectBySlug,
  listProjects,
  ProjectAlreadyExistsError,
} from '../domain/project.js';
import { initHome, loadConfig, warioHome } from '../config.js';
import type {
  PushReviewInput,
  ReviewRequest,
  Verdict,
} from '../shared/types.js';

const program = new Command();
program
  .name('wario')
  .description('Async Code Review inbox — decouple review from agent workflow')
  .version('0.1.0');

function baseUrl(): string {
  if (process.env.WARIO_BASE_URL) return process.env.WARIO_BASE_URL;
  const cfg = loadConfig();
  return `http://${cfg.host}:${cfg.port}`;
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not reach Wario server at ${baseUrl()}. Is it running? Try: wario serve (${msg})`);
  }
  if (res.status === 408) {
    throw new Error(`Timeout: review not decided within wait window`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function readDiff(diffArg: string | undefined): string | undefined {
  if (diffArg === undefined) return undefined;
  if (diffArg === '-') {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      return undefined;
    }
  }
  return readFileSync(diffArg, 'utf8');
}

function defaultActor(): string {
  return process.env.USER ?? process.env.USERNAME ?? 'anonymous';
}

program
  .command('init')
  .description('Initialize ~/.wario/ home directory and default project')
  .action(() => {
    const home = warioHome();
    const cfg = initHome(home);
    const db = openDatabase(cfg.dbPath);
    try {
      const project = ensureDefaultProject(db);
      console.log(`Home:      ${home}/`);
      console.log(`  config:  ${home}/config.json`);
      console.log(`  logs:    ${home}/logs/`);
      console.log(`  run:     ${home}/run/`);
      console.log(`  skill:   ${home}/skill/`);
      console.log(`DB:        ${cfg.dbPath}`);
      console.log(`Project:   ${project.slug} (${project.id})`);
      console.log(`Server:    http://${cfg.host}:${cfg.port}`);
    } finally {
      db.close();
    }
  });

program
  .command('home')
  .description('Print the Wario home directory path')
  .action(() => {
    console.log(warioHome());
  });

program
  .command('config')
  .description('Print the effective runtime config')
  .action(() => {
    console.log(JSON.stringify(loadConfig(), null, 2));
  });

program
  .command('serve')
  .description('Start the HTTP server')
  .option('-p, --port <port>', 'port to listen on', process.env.WARIO_PORT ?? '7331')
  .option('-H, --host <host>', 'host to bind', process.env.WARIO_HOST ?? '127.0.0.1')
  .action(async (opts: { port: string; host: string }) => {
    const { startServer } = await import('../server.js');
    const cfg = loadConfig();
    await startServer({
      port: parseInt(opts.port, 10),
      host: opts.host,
      dbPath: cfg.dbPath,
    });
  });

const projectCmd = program.command('project').description('Manage projects');

projectCmd
  .command('create <slug>')
  .description('Create a new project')
  .option('-n, --name <name>', 'human-readable name (defaults to slug)')
  .option('-d, --description <desc>', 'project description')
  .action((slug: string, opts: { name?: string; description?: string }) => {
    const db = openDatabase(loadConfig().dbPath);
    try {
      const project = createProject(db, {
        slug,
        name: opts.name ?? slug,
        description: opts.description,
      });
      console.log(JSON.stringify(project, null, 2));
    } catch (e) {
      if (e instanceof ProjectAlreadyExistsError) {
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    } finally {
      db.close();
    }
  });

projectCmd
  .command('list')
  .description('List all projects')
  .action(() => {
    const db = openDatabase(loadConfig().dbPath);
    try {
      const projects = listProjects(db);
      console.log(JSON.stringify(projects, null, 2));
    } finally {
      db.close();
    }
  });

projectCmd
  .command('show <slug>')
  .description('Show project details')
  .action((slug: string) => {
    const db = openDatabase(loadConfig().dbPath);
    try {
      const project = getProjectBySlug(db, slug);
      if (!project) {
        console.error(`Project not found: ${slug}`);
        process.exit(1);
      }
      console.log(JSON.stringify(project, null, 2));
    } finally {
      db.close();
    }
  });

program
  .command('push')
  .description('Push a review request (HTTP)')
  .requiredOption('-t, --title <title>', 'review title')
  .option('--project <slug>', 'project slug', 'default')
  .option('-d, --description <desc>', 'review description')
  .option('--diff <path>', 'path to diff file (use "-" for stdin)', '-')
  .option('--risk <level>', 'self-assessed risk (L1|L2|L3)')
  .option('--content-type <type>', 'requirement | plan | code', 'code')
  .option('--tags <tags>', 'comma-separated tags')
  .option('--source <source>', 'source system (e.g. claude-code, codex)')
  .option('--source-ref <ref>', 'source-system reference id')
  .option('--repo-path <path>', 'git repo root for server-side OCR review (also reads WARIO_REPO_PATH env)', process.env.WARIO_REPO_PATH)
  .option('--git-from <ref>', 'git base ref for OCR review (also reads WARIO_GIT_FROM env)', process.env.WARIO_GIT_FROM)
  .option('--git-to <ref>', 'git head ref for OCR review (also reads WARIO_GIT_TO env)', process.env.WARIO_GIT_TO)
  .requiredOption('--session-id <id>', 'agent session id (also reads WARIO_SESSION_ID env)', process.env.WARIO_SESSION_ID)
  .option('--by <pushedBy>', 'pushed-by identifier', defaultActor())
  .action(async (opts: {
    title: string;
    project: string;
    description?: string;
    diff: string;
    risk?: string;
    contentType: string;
    tags?: string;
    source?: string;
    sourceRef?: string;
    repoPath?: string;
    gitFrom?: string;
    gitTo?: string;
    sessionId: string;
    by: string;
  }) => {
    const body: PushReviewInput = {
      projectSlug: opts.project,
      pushedBy: opts.by,
      sessionId: opts.sessionId,
      title: opts.title,
      description: opts.description,
      diff: readDiff(opts.diff),
      selfAssessedRisk: opts.risk as PushReviewInput['selfAssessedRisk'],
      contentType: opts.contentType as PushReviewInput['contentType'],
      tags: opts.tags ? opts.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      source: opts.source,
      sourceRef: opts.sourceRef,
      repoPath: opts.repoPath,
      gitFrom: opts.gitFrom,
      gitTo: opts.gitTo,
    };
    const review = await httpJson<ReviewRequest>(
      `${baseUrl()}/api/projects/${encodeURIComponent(opts.project)}/reviews`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    console.log(JSON.stringify(review, null, 2));
  });

program
  .command('list')
  .description('List reviews (HTTP)')
  .option('--project <slug>', 'project slug', 'default')
  .option('--status <status>', 'pending or decided')
  .option('--limit <n>', 'max results', '50')
  .action(async (opts: { project: string; status?: string; limit: string }) => {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    params.set('limit', opts.limit);
    const url = `${baseUrl()}/api/projects/${encodeURIComponent(opts.project)}/reviews?${params}`;
    const reviews = await httpJson<ReviewRequest[]>(url);
    console.log(JSON.stringify(reviews, null, 2));
  });

program
  .command('show <id>')
  .description('Show review details (HTTP)')
  .option('--pretty', 'human-readable output')
  .action(async (id: string, opts: { pretty?: boolean }) => {
    const review = await httpJson<ReviewRequest>(
      `${baseUrl()}/api/reviews/${encodeURIComponent(id)}`
    );
    if (opts.pretty) {
      printReviewPretty(review);
    } else {
      console.log(JSON.stringify(review, null, 2));
    }
  });

program
  .command('wait <id>')
  .description('Block until the review is decided (HTTP long-poll)')
  .option('--timeout <seconds>', 'max wait time in seconds', '600')
  .action(async (id: string, opts: { timeout: string }) => {
    const timeout = parseInt(opts.timeout, 10);
    const review = await httpJson<ReviewRequest>(
      `${baseUrl()}/api/reviews/${encodeURIComponent(id)}?wait=${timeout}`
    );
    console.log(JSON.stringify(review, null, 2));
  });

program
  .command('decide <id>')
  .description('Decide on a review (HTTP)')
  .requiredOption('--verdict <verdict>', 'approve | reject | comment')
  .option('--comment <comment>', 'decision comment')
  .option('--reviewer <name>', 'reviewer name', defaultActor())
  .action(async (id: string, opts: { verdict: string; comment?: string; reviewer: string }) => {
    const body = {
      verdict: opts.verdict as Verdict,
      comment: opts.comment,
      reviewer: opts.reviewer,
    };
    const review = await httpJson<ReviewRequest>(
      `${baseUrl()}/api/reviews/${encodeURIComponent(id)}/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    console.log(JSON.stringify(review, null, 2));
  });

const reviewCmd = program.command('review').description('Reviewer Agent interaction');

reviewCmd
  .command('resume <id>')
  .description('Resume the review Agent with a follow-up question')
  .requiredOption('--question <q>', 'question to ask the reviewer')
  .action(async (id: string, opts: { question: string }) => {
    const review = await httpJson<ReviewRequest>(
      `${baseUrl()}/api/reviews/${encodeURIComponent(id)}/resume`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: opts.question }),
      }
    );
    console.log(JSON.stringify(review, null, 2));
  });

function printReviewPretty(review: ReviewRequest): void {
  console.log(`ID:        ${review.id}`);
  console.log(`Project:   ${review.projectId}`);
  console.log(`Title:     ${review.context.title}`);
  console.log(`Status:    ${review.status}`);
  console.log(`Risk:      ${review.selfAssessedRisk ?? 'unspecified'}`);
  console.log(`Type:      ${review.contentType ?? 'unspecified'}`);
  console.log(`PushedBy:  ${review.pushedBy}`);
  console.log(`Session:   ${review.sessionId}`);
  console.log(`Created:   ${review.createdAt}`);
  if (review.decidedAt) console.log(`Decided:   ${review.decidedAt}`);
  if (review.context.source) console.log(`Source:    ${review.context.source}${review.context.sourceRef ? ` (${review.context.sourceRef})` : ''}`);
  if (review.context.tags?.length) console.log(`Tags:      ${review.context.tags.join(', ')}`);
  if (review.preReview) {
    console.log('');
    console.log(`Review Agent: ${review.preReview.byAgent} (risk=${review.preReview.riskLevel}, session=${review.preReview.reviewSessionId})`);
    console.log(`  ${review.preReview.summary}`);
    if (review.preReview.findings.length) {
      for (const f of review.preReview.findings) {
        const loc = f.location ? ` @ ${f.location}` : '';
        console.log(`  - [${f.severity}] ${f.category}${loc}: ${f.description}`);
      }
    }
    if (review.preReview.resumeRounds?.length) {
      console.log('');
      console.log(`Resume rounds (${review.preReview.resumeRounds.length}):`);
      for (const r of review.preReview.resumeRounds) {
        console.log(`  Q: ${r.question}`);
        console.log(`  A: ${r.answer.slice(0, 200)}${r.answer.length > 200 ? '...' : ''}`);
        if (r.findings?.length) {
          for (const f of r.findings) {
            const loc = f.location ? ` @ ${f.location}` : '';
            console.log(`    - [${f.severity}] ${f.category}${loc}: ${f.description}`);
          }
        }
      }
    }
    console.log('');
    console.log(`  想追问? wario review resume ${review.id} --question "..."`);
  }
  if (review.context.description) {
    console.log('');
    console.log(review.context.description);
  }
  if (review.context.diff) {
    console.log('');
    console.log('--- diff ---');
    console.log(review.context.diff);
  }
  if (review.decision) {
    console.log('');
    console.log(`Decision:  ${review.decision.verdict} by ${review.decision.reviewer}`);
    if (review.decision.comment) console.log(`Comment:   ${review.decision.comment}`);
  }
}

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});