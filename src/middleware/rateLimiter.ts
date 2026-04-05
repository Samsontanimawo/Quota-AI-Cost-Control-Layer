/**
 * ============================================================
 * Quota — Rate Limiter Middleware
 * ============================================================
 * PURPOSE: Protects the service from abuse by limiting the
 * number of requests per time window. Uses express-rate-limit
 * with in-memory storage (production should use Redis store).
 * ============================================================
 */

import rateLimit from 'express-rate-limit';
import { config } from '../config';

export const rateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: `Rate limit exceeded. Max ${config.rateLimit.maxRequests} requests per ${config.rateLimit.windowMs / 1000}s window.`,
  },
  // Key by API key from body if present, otherwise by IP
  keyGenerator: (req) => {
    return req.body?.apiKey?.slice(0, 12) || req.ip || 'unknown';
  },
});
