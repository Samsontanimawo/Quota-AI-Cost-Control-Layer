/**
 * ============================================================
 * Quota — AI Cost Control Layer
 * ============================================================
 * PURPOSE: Main server entry point. Initializes the Express
 * server with all middleware, routes, and the request pipeline.
 *
 * ARCHITECTURE: Single-process Node.js server. For horizontal
 * scaling, run multiple instances behind a load balancer with
 * Redis for shared cache and rate limiting state.
 *
 * STARTUP SEQUENCE:
 *   1. Validate config
 *   2. Initialize pipeline (creates all service instances)
 *   3. Mount middleware (security, logging, rate limiting)
 *   4. Mount routes
 *   5. Start listening
 *   6. Register graceful shutdown handlers
 * ============================================================
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { config, validateConfig } from './config';
import { RequestPipeline, createRoutes } from './gateway';
import { rateLimiter } from './middleware/rateLimiter';
import { requestLogger } from './middleware/requestLogger';
import { createLogger } from './utils/logger';

const log = createLogger('server');

async function main(): Promise<void> {
  // Step 1: Validate configuration
  validateConfig();

  // Step 2: Initialize the pipeline (all services)
  const pipeline = new RequestPipeline();

  // Step 3: Create Express app with middleware
  const app = express();

  app.use(helmet());                        // Security headers
  app.use(cors());                          // CORS
  app.use(compression());                   // Response compression
  app.use(express.json({ limit: '10mb' })); // Parse JSON bodies (large prompts)
  app.use(requestLogger);                   // Log all requests

  // Step 4: Mount routes
  app.use('/api/v1', rateLimiter, createRoutes(pipeline));

  // Root endpoint — service info
  app.get('/', (_req, res) => {
    res.json({
      service: 'Quota — AI Cost Control Layer',
      version: '1.0.0',
      docs: '/api/v1/health',
      endpoints: {
        chat: 'POST /api/v1/chat',
        preview: 'POST /api/v1/preview',
        usage: 'GET /api/v1/usage/:apiKey',
        globalUsage: 'GET /api/v1/usage',
        budget: 'GET /api/v1/budget/:apiKey',
        models: 'GET /api/v1/models',
        cacheStats: 'GET /api/v1/cache/stats',
        clearCache: 'DELETE /api/v1/cache',
        recent: 'GET /api/v1/recent',
        health: 'GET /api/v1/health',
      },
    });
  });

  // Step 5: Start server
  const server = app.listen(config.port, () => {
    log.info({
      port: config.port,
      env: config.nodeEnv,
      redis: config.redis.enabled,
    }, `Quota server started on port ${config.port}`);

    console.log(`
╔═══════════════════════════════════════════════════════╗
║           Quota — AI Cost Control Layer               ║
║                                                       ║
║  Server:    http://localhost:${config.port}                  ║
║  Health:    http://localhost:${config.port}/api/v1/health    ║
║  Env:       ${config.nodeEnv.padEnd(40)}  ║
║  Redis:     ${(config.redis.enabled ? 'enabled' : 'disabled (using memory cache)').padEnd(40)}  ║
╚═══════════════════════════════════════════════════════╝
    `);
  });

  // Step 6: Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutdown signal received');
    server.close(async () => {
      await pipeline.shutdown();
      log.info('Server shut down gracefully');
      process.exit(0);
    });
    // Force exit after 10s if graceful shutdown hangs
    setTimeout(() => process.exit(1), 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
