import { useEffect, useState, type FormEvent } from "react";

import { useI18n } from "../i18n";
import {
  checkServer,
  describeError,
  login,
  register,
  type DescribedError,
} from "../lib/auth";
import {
  loadAuth,
  normalizeServerUrl,
  type Session,
  type StoredAuth,
} from "../lib/session";
import { LanguageSwitcher } from "./LanguageSwitcher";

type Mode = "login" | "register";
type ServerState = "idle" | "checking" | "ok" | "unreachable";

type Props = {
  onAuthenticated: (auth: StoredAuth) => void;
};

export function LoginScreen({ onAuthenticated }: Props) {
  const { t } = useI18n();
  const saved = loadAuth();

  const [mode, setMode] = useState<Mode>("login");
  const [serverUrl, setServerUrl] = useState(saved?.serverUrl ?? "https://localhost");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
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
      setError({ key: "login.error.missingServer" });
      return;
    }
    if (!username.trim() || !password) {
      setError({ key: "login.error.missingCredentials" });
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
      <LanguageSwitcher className="login-lang" />

      <form className="login-card" onSubmit={submit}>
        <img className="login-logo" src="/app-icon.png" alt="" />
        <h1>{t("app.name")}</h1>
        <p className="login-subtitle">{t("app.tagline")}</p>

        <div className="tabs">
          <button
            type="button"
            className={mode === "login" ? "tab active" : "tab"}
            onClick={() => setMode("login")}
          >
            {t("login.tab.signIn")}
          </button>
          <button
            type="button"
            className={mode === "register" ? "tab active" : "tab"}
            onClick={() => setMode("register")}
          >
            {t("login.tab.register")}
          </button>
        </div>

        <label className="field">
          <span>{t("login.server.label")}</span>
          <input
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="chat.example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <div className={`server-state ${serverState}`}>
          {serverState === "checking" && t("login.server.checking")}
          {serverState === "ok" &&
            (serverVersion
              ? t("login.server.onlineWithVersion", { version: serverVersion })
              : t("login.server.online"))}
          {serverState === "unreachable" && t("login.server.offline")}
          {serverState === "idle" && " "}
        </div>

        <label className="field">
          <span>{t("login.username")}</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>{t("login.password")}</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "register" ? "new-password" : "current-password"}
          />
        </label>

        {mode === "register" && (
          <label className="field">
            <span>{t("login.invite")}</span>
            <input
              value={invite}
              onChange={(event) => setInvite(event.target.value)}
              placeholder={t("login.invitePlaceholder")}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}

        {error && <div className="error">{t(error.key, error.params)}</div>}

        <button className="primary" type="submit" disabled={busy}>
          {busy
            ? t("login.submit.busy")
            : mode === "register"
              ? t("login.submit.register")
              : t("login.submit.signIn")}
        </button>

        {mode === "register" && <p className="hint">{t("login.inviteHint")}</p>}
      </form>
    </div>
  );
}
