import { NextFunction, Request, Response } from 'express';

interface DecodedAuthToken {
  uid: string;
}

export interface RouteAuthOptions {
  allowTestUserHeader?: boolean;
  verifyIdToken?: (idToken: string) => Promise<DecodedAuthToken>;
}

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

function isTestHeaderAllowed(options: RouteAuthOptions): boolean {
  if (options.allowTestUserHeader !== undefined) return options.allowTestUserHeader;
  if (process.env.ASO_ALLOW_TEST_AUTH_HEADER === '1') return true;
  return process.env.NODE_ENV !== 'production' && process.env.ASO_ALLOW_TEST_AUTH_HEADER !== '0';
}

async function verifyFirebaseToken(idToken: string): Promise<DecodedAuthToken> {
  const firebase = await import('../firebase');
  return firebase.auth.verifyIdToken(idToken);
}

export function createRouteAuthMiddleware(options: RouteAuthOptions = {}) {
  const verifyIdToken = options.verifyIdToken ?? verifyFirebaseToken;

  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const decodedToken = await verifyIdToken(authHeader.slice('Bearer '.length).trim());
        req.userId = decodedToken.uid;
        next();
        return;
      }

      const testUserId = req.headers['x-aso-test-user-id'];
      if (isTestHeaderAllowed(options) && typeof testUserId === 'string' && testUserId.trim()) {
        req.userId = testUserId.trim();
        next();
        return;
      }

      res.status(401).json({ error: 'Unauthorized: No token provided' });
    } catch {
      res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
  };
}
