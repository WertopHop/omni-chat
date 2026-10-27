import { useVpn } from "../hooks/useVpn";

type Props = {
  vpn: ReturnType<typeof useVpn>;
  onClose: () => void;
};

function formatUptime(connectedAt: number | null): string {
  if (!connectedAt) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - connectedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds} с`;
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes} мин` : `${hours} ч ${minutes % 60} мин`;
}

export function VpnPanel({ vpn, onClose }: Props) {
  const { available, connected, busy, error, status } = vpn;

  return (
    <aside className="vpn-panel">
      <header className="vpn-header">
        <span className={connected ? "vpn-dot on" : "vpn-dot"} />
        <h3>Туннель</h3>
        <button className="ghost small" onClick={onClose} title="Закрыть">
          ×
        </button>
      </header>

      {!available && (
        <p className="vpn-note">
          VPN работает только в настольном приложении: профиль и туннель живут в
          Rust-части Tauri.
        </p>
      )}

      {available && (
        <>
          <p className="vpn-note">
            Режим «прокси»: локальный SOCKS/HTTP и системный прокси. Управление
            всем трафиком и приложениями появится вместе с TUN-режимом.
          </p>

          <dl className="vpn-facts">
            <dt>Состояние</dt>
            <dd>{connected ? "подключено" : busy ? "подключение…" : "выключено"}</dd>
            <dt>Сервер</dt>
            <dd>{status?.host ?? "—"}</dd>
            <dt>Локальный SOCKS</dt>
            <dd>127.0.0.1:{status?.socks_port ?? 10808}</dd>
            <dt>Системный прокси</dt>
            <dd>{status?.system_proxy ? "включён" : "выключен"}</dd>
            <dt>Аптайм</dt>
            <dd>{formatUptime(status?.connected_at ?? null)}</dd>
          </dl>

          {error && <div className="error">{error}</div>}

          <div className="vpn-actions">
            <button
              className={connected ? "primary danger" : "primary"}
              disabled={busy}
              onClick={vpn.toggle}
            >
              {busy ? "Подключаем…" : connected ? "Отключить" : "Включить VPN"}
            </button>
            <button className="ghost small" onClick={vpn.refresh} disabled={busy}>
              Обновить профиль
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
