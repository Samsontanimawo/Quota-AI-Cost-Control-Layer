/**
 * ============================================================
 * Quota — API Routes
 * ============================================================
 * PURPOSE: REST API endpoints for the Quota service.
 * All routes are mounted under /api/v1/.
 *
 * ENDPOINTS:
 *   POST   /api/v1/chat          — Process an AI request through the full pipeline
 *   POST   /api/v1/preview       — Estimate cost without executing
 *   GET    /api/v1/usage/:apiKey  — Get usage analytics for an API key
 *   GET    /api/v1/usage         — Get global usage analytics
 *   GET    /api/v1/budget/:apiKey — Get budget info for an API key
 *   GET    /api/v1/cache/stats   — Get cache hit/miss statistics
 *   DELETE /api/v1/cache         — Clear the response cache
 *   GET    /api/v1/health        — Health check
 *   GET    /api/v1/models        — List available models and pricing
 * ============================================================
 */

import { Router, Request, Response } from 'express';
import { QuotaRequestSchema, MODEL_PRICING, ClaudeModel } from '../types';
import { RequestPipeline } from './pipeline';
import { createLogger } from '../utils/logger';

const log = createLogger('routes');

export function createRoutes(pipeline: RequestPipeline): Router {
  const router = Router();

  /**
   * POST /api/v1/chat
   * Main endpoint — processes a request through the full Quota pipeline.
   *
   * Body: { apiKey, messages, model?, system?, maxTokens?, temperature?, metadata? }
   * Response: { success, data, meta }
   */
  router.post('/chat', async (req: Request, res: Response) => {
    try {
      const parsed = QuotaRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'Invalid request',
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const result = await pipeline.process(parsed.data);
      const status = result.success ? 200 : (result.error?.includes('blocked') ? 403 : 500);
      res.status(status).json(result);
    } catch (err: any) {
      log.error({ err }, 'Chat endpoint error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  /**
   * POST /api/v1/preview
   * Cost estimation — returns what it WOULD cost without executing.
   * Useful for UIs that want to show cost before the user confirms.
   */
  router.post('/preview', async (req: Request, res: Response) => {
    try {
      const parsed = QuotaRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'Invalid request',
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const preview = await pipeline.preview(parsed.data);
      res.json({ success: true, data: preview });
    } catch (err: any) {
      log.error({ err }, 'Preview endpoint error');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  /**
   * GET /api/v1/usage/:apiKey
   * Usage analytics for a specific API key (last 24h by default).
   */
  router.get('/usage/:apiKey', (req: Request, res: Response) => {
    const apiKey = req.params.apiKey as string;
    const since = req.query.since ? parseInt(req.query.since as string) : undefined;
    const summary = pipeline.getAnalytics(apiKey, since);
    res.json({ success: true, data: summary });
  });

  /**
   * GET /api/v1/usage
   * Global usage analytics across all API keys.
   */
  router.get('/usage', (_req: Request, res: Response) => {
    const summary = pipeline.getGlobalAnalytics();
    res.json({ success: true, data: summary });
  });

  /**
   * GET /api/v1/budget/:apiKey
   * Budget information: spent, remaining, daily limit.
   */
  router.get('/budget/:apiKey', (req: Request, res: Response) => {
    const apiKey = req.params.apiKey as string;
    const budget = pipeline.getBudgetInfo(apiKey);
    res.json({ success: true, data: budget });
  });

  /**
   * GET /api/v1/cache/stats
   * Cache performance metrics.
   */
  router.get('/cache/stats', (_req: Request, res: Response) => {
    const stats = pipeline.getCacheStats();
    res.json({ success: true, data: stats });
  });

  /**
   * DELETE /api/v1/cache
   * Clear all cached responses.
   */
  router.delete('/cache', async (_req: Request, res: Response) => {
    await pipeline.clearCache();
    res.json({ success: true, message: 'Cache cleared' });
  });

  /**
   * GET /api/v1/recent
   * Recent request log (last 50 by default).
   */
  router.get('/recent', (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const records = pipeline.getRecentRequests(limit);
    res.json({ success: true, data: records });
  });

  /**
   * GET /api/v1/models
   * List available models with pricing.
   */
  router.get('/models', (_req: Request, res: Response) => {
    const models = Object.entries(MODEL_PRICING).map(([model, pricing]) => ({
      model,
      inputPer1MTokens: pricing.inputPer1M,
      outputPer1MTokens: pricing.outputPer1M,
      tier: model.includes('haiku') ? 'economy' : model.includes('sonnet') ? 'balanced' : 'premium',
    }));
    res.json({ success: true, data: models });
  });

  /**
   * GET /api/v1/health
   * Health check — returns service status.
   */
  router.get('/health', (_req: Request, res: Response) => {
    const cacheStats = pipeline.getCacheStats();
    res.json({
      status: 'healthy',
      service: 'quota',
      version: '1.0.0',
      uptime: process.uptime(),
      cache: cacheStats,
    });
  });

  return router;
}
