import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  createProject,
  getProjectBySlug,
  listProjects,
  ProjectAlreadyExistsError,
} from '../domain/project.js';

interface CreateProjectBody {
  slug?: string;
  name?: string;
  description?: string;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  db: Database.Database
): void {
  app.post('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as CreateProjectBody;
    if (!body.slug || typeof body.slug !== 'string') {
      return reply.code(400).send({ error: 'slug is required' });
    }
    try {
      const project = createProject(db, {
        slug: body.slug,
        name: body.name ?? body.slug,
        description: body.description,
      });
      return reply.code(201).send(project);
    } catch (e) {
      if (e instanceof ProjectAlreadyExistsError) {
        return reply.code(409).send({ error: e.message });
      }
      throw e;
    }
  });

  app.get('/api/projects', async (_req, reply) => {
    return reply.send(listProjects(db));
  });

  app.get<{ Params: { slug: string } }>('/api/projects/:slug', async (req, reply) => {
    const project = getProjectBySlug(db, req.params.slug);
    if (!project) {
      return reply.code(404).send({ error: `Project not found: ${req.params.slug}` });
    }
    return reply.send(project);
  });
}