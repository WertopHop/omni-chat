import { useEffect, useState, type FormEvent } from "react";

import { checkServer, describeError, login, register } from "../lib/auth";
import {
  loadAuth,
  normalizeServerUrl,
  type Session,
  type StoredAuth,
} from "../lib/session";

type Mode = "login" | "register";
type ServerState = "idle" | "checking" | "ok" | "unreachable";

type Props = {
  onAuthenticated: (auth: StoredAuth) => void;
};

export function LoginScreen({ onAuthenticated }: Props) {
  const saved = loadAuth();

  const [mode, setMode] = useState<Mode>("login");
  const [serverUrl, setServerUrl] = useState(saved?.serverUrl ?? "https://localhost");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverState, setServerState] = useState<ServerState>("idle");
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  useEffect(() => {
    const url = normalizeServerUrl(serverUrl);
    if (!url) {
      setServerState("idle");
      return;
    }

    let active = true;
    setServerState("checking");

    const timer = window.setTimeout(async () => {
      const result = await checkServer(url);
      if (!active) return;
      setServerState(result.ok ? "ok" : "unreachable");
      setServerVersion(result.version ?? null);
    }, 400);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [serverUrl]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    const url = normalizeServerUrl(serverUrl);
    if (!url) {
      setError("Укажите адрес сервера.");
      return;
    }
    if (!username.trim() || !password) {
      setError("Заполните ник и пароль.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const session: Session =
        mode === "register"
          ? await register(url, username.trim(), password, invite.trim())
          : await login(url, username.trim(), password);

      onAuthenticated({ serverUrl: url, session });
    } catch (submitError) {
      setError(describeError(submitError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <img className="login-logo" src="/app-icon.png" alt="" />
        <h1>omni-chat</h1>
        <p className="login-subtitle">Приватный сервер для своих</p>

        <div className="tabs">
          <button
            type="button"
            className={mode === "login" ? "tab active" : "tab"}
            onClick={() => setMode("login")}
          >
            Вход
          </button>
          <button
            type="button"
            className={mode === "register" ? "tab active" : "tab"}
            onClick={() => setMode("register")}
          >
            Регистрация
          </button>
        </div>

        <label className="field">
          <span>Адрес сервера</span>
          <input
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="chat.example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <div className={`server-state ${serverState}`}>
          {serverState === "checking" && "Проверяем сервер…"}
          {serverState === "ok" &&
            `Сервер доступен${serverVersion ? ` (${serverVersion})` : ""}`}
          {serverState === "unreachable" && "Сервер не отвечает"}
          {serverState === "idle" && " "}
        </div>

        <label className="field">
          <span>Ник</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Пароль</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "register" ? "new-password" : "current-password"}
          />
        </label>

        {mode === "register" && (
          <label className="field">
            <span>Инвайт-код</span>
            <input
              value={invite}
              onChange={(event) => setInvite(event.target.value)}
              placeholder="выдаёт администратор"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}

        {error && <div className="error">{error}</div>}

        <button className="primary" type="submit" disabled={busy}>
          {busy
            ? "Подождите…"
            : mode === "register"
              ? "Создать аккаунт"
              : "Войти"}
        </button>

        {mode === "register" && (
          <p className="hint">
            Аккаунт создаётся по инвайт-коду: сервер закрытый, доступ выдаёт
            администратор.
          </p>
        )}
      </form>
    </div>
  );
}
