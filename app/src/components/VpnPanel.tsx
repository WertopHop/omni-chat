import { useVpn } from "../hooks/useVpn";
import { useI18n, type Translate } from "../i18n";
import type { VpnIssue } from "../lib/vpn";

type Props = {
  vpn: ReturnType<typeof useVpn>;
  onClose: () => void;
};

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

export function VpnPanel({ vpn, onClose }: Props) {
  const { t } = useI18n();
  const { available, connected, busy, issue, status } = vpn;

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
          <p className="vpn-note">{t("vpn.modeNote")}</p>

          <dl className="vpn-facts">
            <dt>{t("vpn.fact.state")}</dt>
            <dd>
              {connected
                ? t("vpn.state.connected")
                : busy
                  ? t("vpn.state.connecting")
                  : t("vpn.state.disabled")}
            </dd>
            <dt>{t("vpn.fact.server")}</dt>
            <dd>{status?.host ?? t("errors.common.dash")}</dd>
            <dt>{t("vpn.fact.socks")}</dt>
            <dd>127.0.0.1:{status?.socks_port ?? 10808}</dd>
            <dt>{t("vpn.fact.systemProxy")}</dt>
            <dd>
              {status?.system_proxy ? t("vpn.systemProxy.on") : t("vpn.systemProxy.off")}
            </dd>
            <dt>{t("vpn.fact.uptime")}</dt>
            <dd>{formatUptime(status?.connected_at ?? null, t)}</dd>
          </dl>

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
