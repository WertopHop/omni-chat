/**
 * Authentication calls against the gateway (not the chat API directly).
 *
 * The gateway hides the backend's e-mail based accounts: users sign in with a
 * nickname, and an account can only be created with an invite code.
 */
import type { MessageKey } from "../i18n";
import { apiBaseUrl, type Session } from "./session";

export class AuthError extends Error {
  /** Server error type, e.g. `InvalidInvite`. */
  readonly kind: string;

  constructor(kind: string) {
    super(kind);
    this.kind = kind;
  }
}

const HINTS: Partial<Record<string, MessageKey>> = {
  InvalidCredentials: "errors.invalidCredentials",
  MissingInvite: "errors.missingInvite",
  InvalidInvite: "errors.invalidInvite",
  UsernameTaken: "errors.usernameTaken",
  InvalidUsername: "errors.invalidUsername",
  ShortPassword: "errors.shortPassword",
  CompromisedPassword: "errors.compromisedPassword",
  FailedValidation: "errors.failedValidation",
  InvalidSession: "errors.invalidSession",
};

export type DescribedError = {
  key: MessageKey;
  params?: Record<string, string | number>;
};

/** Maps any thrown value to a dictionary key for the current language. */
export function describeError(error: unknown): DescribedError {
  if (error instanceof AuthError) {
    const key = HINTS[error.kind];
    return key ? { key } : { key: "errors.server", params: { kind: error.kind } };
  }
  if (error instanceof Error) {
    return error.message.includes("fetch")
      ? { key: "errors.unreachable" }
      : { key: "errors.raw", params: { message: error.message } };
  }
  return { key: "errors.unknown" };
}

async function post<T>(serverUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl(serverUrl)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    const kind =
      typeof payload === "object" && payload !== null && "type" in payload
        ? String((payload as { type: unknown }).type)
        : `HTTP ${response.status}`;
    throw new AuthError(kind);
  }

  return payload as T;
}

type SessionResponse = Session & { result?: string };

export async function login(
  serverUrl: string,
  username: string,
  password: string,
): Promise<Session> {
  const session = await post<SessionResponse>(serverUrl, "/auth/login", {
    username,
    password,
  });
  return requireSession(session);
}

export async function register(
  serverUrl: string,
  username: string,
  password: string,
  invite: string,
): Promise<Session> {
  const session = await post<SessionResponse>(serverUrl, "/auth/register", {
    username,
    password,
    invite,
  });
  return requireSession(session);
}

export async function checkServer(
  serverUrl: string,
): Promise<{ ok: boolean; version?: string }> {
  try {
    const response = await fetch(apiBaseUrl(serverUrl));
    if (!response.ok) return { ok: false };
    const payload = (await response.json()) as { revolt?: string };
    return { ok: true, version: payload.revolt };
  } catch {
    return { ok: false };
  }
}

function requireSession(session: SessionResponse | undefined): Session {
  if (!session?.token || !session.user_id) {
    throw new AuthError("InvalidSession");
  }
  return { _id: session._id, token: session.token, user_id: session.user_id };
}
