import { useState } from "react";

import { useVpn } from "../hooks/useVpn";
import { useI18n, type MessageKey, type Translate } from "../i18n";
import type { AppPolicy, VpnIssue, VpnMode } from "../lib/vpn";

type Props = {
  vpn: ReturnType<typeof useVpn>;
  onClose: () => void;
};

const MODES: VpnMode[] = ["proxy", "tun"];

const POLICIES: { value: AppPolicy; label: MessageKey }[] = [
  { value: "all", label: "vpn.apps.policy.all" },
  { value: "only", label: "vpn.apps.policy.only" },
  { value: "except", label: "vpn.apps.policy.except" },
];

const POLICY_NOTE: Record<AppPolicy, MessageKey> = {
  all: "vpn.apps.note.all",
  only: "vpn.apps.note.only",
  except: "vpn.apps.note.except",
};

/** The engine compares process names case-sensitively; the UI keeps them sane. */
const MAX_PICKER_ROWS = 80;

function formatUptime(connectedAt: number | null, t: Translate): string {
  if (!connectedAt) return t("errors.common.dash");
  const seconds = Math.max(0, Math.floor((Date.now() - connectedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return t("vpn.uptime.seconds", { count: seconds });
  const hours = Math.floor(minutes / 60);
  return hours === 0
    ? t("vpn.uptime.minutes", { count: minutes })
    : t("vpn.uptime.hours", { hours, minutes: minutes % 60 });
}

function describeIssue(issue: VpnIssue, t: Translate): string {
  return "text" in issue ? issue.text : t(issue.key, issue.params);
}

function hasApp(apps: string[], name: string): boolean {
  return apps.some((known) => known.toLowerCase() === name.toLowerCase());
}

function toggleApp(apps: string[], name: string): string[] {
  return hasApp(apps, name) ? apps.filter((known) => known.toLowerCase() !== name.toLowerCase()) : [...apps, name];
}

type AppsProps = {
  policy: AppPolicy;
  apps: string[];
  pending: boolean;
  disabled: boolean;
  onChange: (policy: AppPolicy, apps: string[]) => void;
  onApply: () => void;
  onList: () => Promise<string[]>;
};

/**
 * Application list for full tunnel mode. Picking from the running processes is
 * the reliable path because the engine matches the name exactly as the system
 * reports it; typing is there for something that is not running right now.
 */
function AppsSection({ policy, apps, pending, disabled, onChange, onApply, onList }: AppsProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [running, setRunning] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function load() {
    if (loading) return;
    if (running) {
      setRunning(null);
      setFilter("");
      return;
    }
    setLoading(true);
    setFailure(null);
    try {
      setRunning(await onList());
    } catch {
      setFailure(t("vpn.apps.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  function add() {
    const name = draft.trim();
    if (!name) return;
    onChange(policy, hasApp(apps, name) ? apps : [...apps, name]);
    setDraft("");
  }

  const needle = filter.trim().toLowerCase();
  const shown = (running ?? [])
    .filter((name) => name.toLowerCase().includes(needle))
    .slice(0, MAX_PICKER_ROWS);

  return (
    <section className="vpn-apps">
      <div className="vpn-apps-head">
        <h4>{t("vpn.apps.title")}</h4>
        {pending && (
          <button
            type="button"
            className="vpn-apps-pending"
            disabled={disabled}
            onClick={onApply}
          >
            {t("vpn.apps.pending")}
          </button>
        )}
      </div>

      <div className="vpn-modes" role="group" aria-label={t("vpn.apps.title")}>
        {POLICIES.map((option) => (
          <button
            key={option.value}
            type="button"
            className={policy === option.value ? "vpn-mode active" : "vpn-mode"}
            aria-pressed={policy === option.value}
            disabled={disabled}
            onClick={() => onChange(option.value, apps)}
          >
            {t(option.label)}
          </button>
        ))}
      </div>

      <p className="vpn-note">{t(POLICY_NOTE[policy])}</p>

      {policy !== "all" && (
        <>
          <ul className="vpn-apps-list">
            {apps.length === 0 && <li className="vpn-apps-empty">{t("vpn.apps.empty")}</li>}
            {apps.map((name) => (
              <li key={name}>
                <span>{name}</span>
                <button
                  type="button"
                  className="ghost small"
                  title={t("vpn.apps.remove", { name })}
                  aria-label={t("vpn.apps.remove", { name })}
                  onClick={() => onChange(policy, apps.filter((known) => known !== name))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          <form
            className="vpn-apps-add"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <input
              value={draft}
              placeholder={t("vpn.apps.placeholder")}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="ghost small" type="submit" disabled={disabled || !draft.trim()}>
              {t("vpn.apps.add")}
            </button>
          </form>

          <button className="ghost small" type="button" onClick={load} disabled={disabled || loading}>
            {loading ? t("vpn.apps.loading") : t("vpn.apps.pick")}
          </button>

          {failure && <div className="error">{failure}</div>}

          {running && (
            <div className="vpn-apps-pick">
              <input
                value={filter}
                placeholder={t("vpn.apps.filter")}
                onChange={(event) => setFilter(event.target.value)}
              />
              <ul>
                {shown.map((name) => (
                  <li key={name}>
                    <label>
                      <input
                        type="checkbox"
                        checked={hasApp(apps, name)}
                        onChange={() => onChange(policy, toggleApp(apps, name))}
                      />
                      <span>{name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="vpn-note">{t("vpn.apps.hint")}</p>
        </>
      )}
    </section>
  );
}

export function VpnPanel({ vpn, onClose }: Props) {
  const { t } = useI18n();
  const { available, connected, busy, reconnecting, elevated, issue, mode, status } = vpn;

  const state = connected
    ? t("vpn.state.connected")
    : reconnecting
      ? t("vpn.state.reconnecting")
      : busy
        ? t("vpn.state.connecting")
        : t("vpn.state.disabled");

  return (
    <aside className="vpn-panel">
      <header className="vpn-header">
        <span className={connected ? "vpn-dot on" : "vpn-dot"} />
        <h3>{t("vpn.title")}</h3>
        <button className="ghost small" onClick={onClose} title={t("vpn.close")}>
          ×
        </button>
      </header>

      {!available ? (
        <p className="vpn-note">{t("vpn.unavailable")}</p>
      ) : (
        <>
          <div className="vpn-modes" role="group" aria-label={t("vpn.mode.label")}>
            {MODES.map((value) => (
              <button
                key={value}
                type="button"
                className={mode === value ? "vpn-mode active" : "vpn-mode"}
                aria-pressed={mode === value}
                disabled={busy}
                onClick={() => vpn.setMode(value)}
              >
                {t(value === "tun" ? "vpn.mode.tun" : "vpn.mode.proxy")}
              </button>
            ))}
          </div>

          <p className="vpn-note">
            {t(mode === "tun" ? "vpn.mode.tunNote" : "vpn.mode.proxyNote")}
          </p>

          <dl className="vpn-facts">
            <dt>{t("vpn.fact.state")}</dt>
            <dd>{state}</dd>
            <dt>{t("vpn.fact.server")}</dt>
            <dd>{status?.host ?? t("errors.common.dash")}</dd>
            {mode === "tun" ? (
              <>
                <dt>{t("vpn.fact.tunnel")}</dt>
                <dd>{status?.tun_name ?? t("errors.common.dash")}</dd>
                <dt>{t("vpn.fact.elevation")}</dt>
                <dd>
                  {elevated ? t("vpn.elevation.admin") : t("vpn.elevation.user")}
                </dd>
              </>
            ) : (
              <>
                <dt>{t("vpn.fact.socks")}</dt>
                <dd>127.0.0.1:{status?.socks_port ?? 10808}</dd>
                <dt>{t("vpn.fact.systemProxy")}</dt>
                <dd>
                  {status?.system_proxy ? t("vpn.systemProxy.on") : t("vpn.systemProxy.off")}
                </dd>
              </>
            )}
            <dt>{t("vpn.fact.uptime")}</dt>
            <dd>{formatUptime(status?.connected_at ?? null, t)}</dd>
          </dl>

          {mode === "tun" && (
            <AppsSection
              policy={vpn.policy}
              apps={vpn.apps}
              pending={vpn.appsPending}
              disabled={busy}
              onChange={vpn.saveApps}
              onApply={vpn.applyApps}
              onList={vpn.listProcesses}
            />
          )}

          {issue && <div className="error">{describeIssue(issue, t)}</div>}

          <div className="vpn-actions">
            <button
              className={connected ? "primary danger" : "primary"}
              disabled={busy}
              onClick={vpn.toggle}
            >
              {busy
                ? t("vpn.action.busy")
                : connected
                  ? t("vpn.action.disconnect")
                  : t("vpn.action.connect")}
            </button>
            <button className="ghost small" onClick={vpn.refresh} disabled={busy}>
              {t("vpn.action.refresh")}
            </button>
          </div>

          {status && status.log.length > 0 && (
            <pre className="vpn-log">{status.log.slice(-8).join("\n")}</pre>
          )}
        </>
      )}
    </aside>
  );
}
