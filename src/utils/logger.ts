/**
 * ============================================================
 * Quota — Structured Logger
 * ============================================================
 * PURPOSE: Production-grade structured logging via Pino.
 * All log entries are JSON in production, pretty-printed in dev.
 * Child loggers are created per-module for easy filtering.
 * ============================================================
 */

import pino from 'pino';
import { config } from '../config';

const transport = config.nodeEnv === 'development'
  ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
  : undefined;

export const logger = pino({
  level: config.logLevel,
  transport,
  base: { service: 'quota' },
  serializers: pino.stdSerializers,
});

/** Create a child logger scoped to a specific module. */
export function createLogger(module: string) {
  return logger.child({ module });
}
