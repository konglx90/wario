import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface WarioConfig {
  port: number;
  host: string;
  dbPath: string;
  preReview: {
    enabled: boolean;
    claudeCmd: string;
    codexCmd: string;
    defaultReviewer: 'claude' | 'codex';
    timeoutSec: number;
  };
}

export function warioHome(): string {
  return process.env.WARIO_HOME ?? `${process.env.HOME ?? '/tmp'}/.wario`;
}

export function defaultConfig(): WarioConfig {
  const home = warioHome();
  return {
    port: 7331,
    host: '127.0.0.1',
    dbPath: join(home, 'data.db'),
    preReview: {
      enabled: true,
      claudeCmd: 'claude',
      codexCmd: 'codex',
      defaultReviewer: 'claude',
      timeoutSec: 120,
    },
  };
}

export function loadConfig(): WarioConfig {
  const cfg = defaultConfig();
  const configPath = join(warioHome(), 'config.json');
  if (existsSync(configPath)) {
    try {
      const file = JSON.parse(readFileSync(configPath, 'utf8'));
      if (typeof file.port === 'number') cfg.port = file.port;
      if (typeof file.host === 'string') cfg.host = file.host;
      if (typeof file.dbPath === 'string') cfg.dbPath = file.dbPath;
      if (file.preReview) {
        if (typeof file.preReview.enabled === 'boolean') cfg.preReview.enabled = file.preReview.enabled;
        if (typeof file.preReview.claudeCmd === 'string') cfg.preReview.claudeCmd = file.preReview.claudeCmd;
        if (typeof file.preReview.codexCmd === 'string') cfg.preReview.codexCmd = file.preReview.codexCmd;
        if (
          file.preReview.defaultReviewer === 'claude' ||
          file.preReview.defaultReviewer === 'codex'
        ) {
          cfg.preReview.defaultReviewer = file.preReview.defaultReviewer;
        }
        if (typeof file.preReview.timeoutSec === 'number') {
          cfg.preReview.timeoutSec = file.preReview.timeoutSec;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[wario] config.json parse error: ${msg}`);
    }
  }

  // Env var overrides (always win)
  if (process.env.WARIO_PORT) cfg.port = parseInt(process.env.WARIO_PORT, 10);
  if (process.env.WARIO_HOST) cfg.host = process.env.WARIO_HOST;
  if (process.env.WARIO_DB) cfg.dbPath = process.env.WARIO_DB;
  if (process.env.WARIO_PREREVIEW === 'disabled') cfg.preReview.enabled = false;
  if (process.env.WARIO_CLAUDE_CMD) cfg.preReview.claudeCmd = process.env.WARIO_CLAUDE_CMD;
  if (process.env.WARIO_CODEX_CMD) cfg.preReview.codexCmd = process.env.WARIO_CODEX_CMD;
  if (
    process.env.WARIO_DEFAULT_REVIEWER === 'claude' ||
    process.env.WARIO_DEFAULT_REVIEWER === 'codex'
  ) {
    cfg.preReview.defaultReviewer = process.env.WARIO_DEFAULT_REVIEWER;
  }
  if (process.env.WARIO_PREREVIEW_TIMEOUT) {
    cfg.preReview.timeoutSec = parseInt(process.env.WARIO_PREREVIEW_TIMEOUT, 10);
  }

  return cfg;
}

export function initHome(home: string = warioHome()): WarioConfig {
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  mkdirSync(join(home, 'run'), { recursive: true });
  mkdirSync(join(home, 'skill'), { recursive: true });
  const cfg = defaultConfig();
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify(cfg, null, 2) + '\n'
  );
  return cfg;
}