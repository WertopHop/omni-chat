/**
 * Authentication calls against the gateway (not the chat API directly).
 *
 * The gateway hides the backend's e-mail based accounts: users sign in with a
 * nickname, and an account can only be created with an invite code.
 */
import { apiBaseUrl, type Session } from "./session";

export class AuthError extends Error {
  readonly kind: string;

  constructor(kind: string, message?: string) {
    super(message ?? kind);
    this.kind = kind;
  }
}

const HINTS: Record<string, string> = {
  InvalidCredentials: "Неверный ник или пароль.",
  MissingInvite: "Нужен инвайт-код от администратора.",
  InvalidInvite: "Инвайт-код неверный или уже использован.",
  UsernameTaken: "Этот ник уже занят.",
  InvalidUsername: "Ник: 2-32 символа, буквы, цифры, точка, дефис, подчёркивание.",
  ShortPassword: "Пароль должен быть не короче 8 символов.",
  CompromisedPassword: "Такой пароль слишком часто утекал, выберите другой.",
  FailedValidation: "Сервер отклонил данные.",
};

export function describeError(error: unknown): string {
  if (error instanceof AuthError) {
    return HINTS[error.kind] ?? `Ошибка сервера: ${error.kind}`;
  }
  if (error instanceof Error) {
    return error.message.includes("fetch")
      ? "Сервер недоступен: проверьте адрес и интернет."
      : error.message;
  }
  return "Неизвестная ошибка.";
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
    throw new AuthError("InvalidSession", "Сервер не вернул сессию.");
  }
  return { _id: session._id, token: session.token, user_id: session.user_id };
}
