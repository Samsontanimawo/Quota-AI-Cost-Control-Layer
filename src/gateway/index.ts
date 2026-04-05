/**
 * ============================================================
 * Quota — API Gateway
 * ============================================================
 * PURPOSE: HTTP server entry point. Configures Express with
 * security middleware, rate limiting, and routes.
 * Exports the configured app for use by the main server.
 * ============================================================
 */

export { createRoutes } from './routes';
export { RequestPipeline } from './pipeline';
