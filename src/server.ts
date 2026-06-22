import Fastify from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from './db/index.js';
import { registerProjectRoutes } from './api/projects.js';
import { registerReviewRoutes } from './api/reviews.js';
import { loadConfig } from './config.js';

export interface ServerConfig {
  port: number;
  host: string;
  dbPath: string;
}

function resolvePublicDir(): string {
  const filename = fileURLToPath(import.meta.url);
  const here = dirname(filename);
  return join(here, 'public');
}

export async function startServer(config: ServerConfig): Promise<void> {
  const app = Fastify({ logger: { level: 'info' } });
  const db = openDatabase(config.dbPath);
  const publicDir = resolvePublicDir();

  app.get('/api/health', async () => ({
    status: 'ok',
    db: config.dbPath,
    publicDir,
    warioHome: process.env.WARIO_HOME ?? `${process.env.HOME ?? '/tmp'}/.wario`,
  }));

  app.get('/', async (_req, reply) => {
    const htmlPath = join(publicDir, 'index.html');
    if (!existsSync(htmlPath)) {
      return reply.code(500).send({ error: 'dashboard not built (run: pnpm run build)' });
    }
    const html = readFileSync(htmlPath, 'utf8');
    return reply.type('text/html').send(html);
  });

  registerProjectRoutes(app, db);
  registerReviewRoutes(app, db);

  app.addHook('onClose', async () => {
    db.close();
  });

  await app.listen({ port: config.port, host: config.host });
  console.log(`Wario listening at http://${config.host}:${config.port}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cfg = loadConfig();
  startServer({ port: cfg.port, host: cfg.host, dbPath: cfg.dbPath }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}