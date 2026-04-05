/**
 * ============================================================
 * Quota — Request Logger Middleware
 * ============================================================
 * PURPOSE: Logs every incoming HTTP request with method, path,
 * status code, and duration. Useful for debugging and monitoring.
 * ============================================================
 */

import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger';

const log = createLogger('http');

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'warn' : 'info';

    log[level]({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: duration,
      ip: req.ip,
    }, `${req.method} ${req.path} ${res.statusCode}`);
  });

  next();
}
