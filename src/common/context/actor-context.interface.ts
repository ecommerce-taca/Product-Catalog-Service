export interface ActorContext {
  userId?: string;
  roles: string[];
  permissions: string[];
  shopScope?: string;
  isAuthenticated: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: ActorContext;
    }
  }
}
