import { AsyncLocalStorage } from "node:async_hooks";

import type { SessionCookiePayload } from "./session-cookie";
import { readSessionCookie, SessionCookieError } from "./session-cookie";

export interface RequestAuthContext {
  npub: string | null;
  session: SessionCookiePayload | null;
  error?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestAuthContext>();

const defaultContext: RequestAuthContext = {
  npub: null,
  session: null,
};

export const resolveRequestAuthContext = (request: Request): RequestAuthContext => {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return { ...defaultContext };
  }

  try {
    const session = readSessionCookie(cookieHeader);
    if (!session) {
      return { ...defaultContext };
    }
    return {
      npub: session.npub,
      session,
    };
  } catch (error) {
    if (error instanceof SessionCookieError) {
      return {
        ...defaultContext,
        error: error.message,
      };
    }
    return {
      ...defaultContext,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const runWithRequestContext = async <T>(context: RequestAuthContext, handler: () => Promise<T> | T): Promise<T> => {
  return await requestContextStorage.run(context, async () => {
    return await handler();
  });
};

export const getRequestContext = (): RequestAuthContext => requestContextStorage.getStore() ?? { ...defaultContext };

export const getAuthenticatedNpub = (): string | null => getRequestContext().npub;
