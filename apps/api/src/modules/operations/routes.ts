import { Router } from 'express';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { authenticate, type AuthConfig } from '../auth/service.js';
import { actorOf } from '../catalog/routes.js';
import { ensure } from '../../lib/errors.js';
import { Notification } from '../../models/index.js';
import { audit, objectId } from '../../services/context.js';
import { queueNames } from '../../runtime.js';
export function operationRoutes(config: AuthConfig) {
  const router = Router();
  router.use(async (req, res, next) => {
    res.locals.actor ??= await authenticate(req.get('authorization'), config);
    ensure(actorOf(res).role === 'admin', 403, 'FORBIDDEN', 'Administrator access required');
    next();
  });
  const connect = (name: string) => {
    ensure(
      queueNames.includes(name as (typeof queueNames)[number]),
      404,
      'NOT_FOUND',
      'Queue not found',
    );
    const url = new URL(process.env.REDIS_URL!);
    return new Queue(name, {
      prefix: process.env.QUEUE_PREFIX ?? 'subscriptiq',
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
        db: Number(url.pathname.slice(1) || 0),
        tls: url.protocol === 'rediss:' ? { servername: url.hostname } : undefined,
        maxRetriesPerRequest: 1,
      },
    });
  };
  router.get('/jobs/failed', async (_req, res) => {
    const results = [];
    for (const name of queueNames) {
      const queue = connect(name);
      try {
        const jobs = await queue.getJobs(['failed'], 0, 49);
        results.push(
          ...jobs.map((job) => ({
            queue: name,
            id: job.id,
            name: job.name,
            attemptsMade: job.attemptsMade,
            failedReason: job.failedReason,
            timestamp: job.timestamp,
          })),
        );
      } finally {
        await queue.close();
      }
    }
    res.json({ data: results });
  });
  router.post('/jobs/:queue/:id/retry', async (req, res) => {
    const queue = connect(z.string().parse(req.params.queue));
    try {
      const job = await queue.getJob(z.string().max(200).parse(req.params.id));
      ensure(job, 404, 'NOT_FOUND', 'Job not found');
      ensure(
        (await job.getState()) === 'failed',
        409,
        'INVALID_STATE',
        'Only failed jobs can be retried',
      );
      await job.retry();
      await audit(actorOf(res), 'retried', 'Job', job.id);
      res.json({ data: { message: 'Job queued for retry' } });
    } finally {
      await queue.close();
    }
  });
  router.post('/notifications/:id/retry', async (req, res) => {
    const row = await Notification.findOneAndUpdate(
      { _id: objectId(req.params.id), status: 'failed' },
      { status: 'pending', attempts: 0 },
      { returnDocument: 'after' },
    );
    ensure(row, 404, 'NOT_FOUND', 'Failed notification not found');
    const queue = connect('subscriptiq-email');
    try {
      const job = await queue.getJob(String(row._id));
      if (job) await job.remove();
      await queue.add(
        'deliver',
        { notificationId: String(row._id) },
        { jobId: String(row._id), attempts: 5, backoff: { type: 'exponential', delay: 2000 } },
      );
    } finally {
      await queue.close();
    }
    await audit(actorOf(res), 'retried', 'Notification', row._id);
    res.json({ data: { message: 'Notification queued for retry' } });
  });
  return router;
}
