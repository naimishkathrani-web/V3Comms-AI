import { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';

/**
 * Authentication middleware for /api routes.
 * Requires API_AUTH_TOKEN env var to be set; if empty, auth is disabled (dev mode).
 * Checks either Authorization: Bearer <token> or query param ?token=<token>
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requiredToken = config.apiAuthToken;

  // If no token configured, skip auth (dev mode)
  if (!requiredToken) {
    return next();
  }

  // Check Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === requiredToken) return next();
  }

  // Check query param
  const queryToken = req.query.token as string | undefined;
  if (queryToken === requiredToken) return next();

  res.status(401).json({ success: false, error: 'Unauthorized — valid token required' });
}

/**
 * Strip API keys from model config objects before sending to client.
 */
export function sanitizeModelConfig(model: any): any {
  const { apiKey, ...rest } = model;
  return {
    ...rest,
    apiKey: apiKey ? '••••••••' : '', // Show masked indicator if key exists
    hasApiKey: Boolean(apiKey),
  };
}
