/**
 * VPN bridge between the UI and the Rust side (`src-tauri/src/vpn.rs`).
 *
 * The tunnel profile is issued by the server for the current session; the UI
 * never renders keys, it only forwards them to the local sidecar.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

import { normalizeServerUrl, type Session } from "./session";

export type VpnProfile = {
  name: string;
  host: string;
  port: number;
  uuid: string;
  flow: string;
  reality: {
    serverName: string;
    publicKey: string;
    shortId: string;
    fingerprint: string;
  };
};

export type VpnStatus = {
  running: boolean;
  socks_port: number;
  http_port: number;
  connected_at: number | null;
  name: string | null;
  host: string | null;
  error: string | null;
  system_proxy: boolean;
  log: string[];
};

export class VpnError extends Error {}

export function vpnAvailable(): boolean {
  return isTauri();
}

export async function fetchVpnProfile(
  serverUrl: string,
  session: Session,
): Promise<VpnProfile> {
  let response: Response;
  try {
    response = await fetch(`${normalizeServerUrl(serverUrl)}/api/vpn/profile`, {
      headers: { "X-Session-Token": session.token },
    });
  } catch {
    throw new VpnError("Сервер недоступен: не удалось получить профиль VPN.");
  }

  if (response.status === 401) {
    throw new VpnError("Сессия истекла: войдите заново, чтобы получить профиль VPN.");
  }
  if (response.status === 503) {
    throw new VpnError("Профиль VPN не найден на сервере (проверьте generated/client-profile.json).");
  }
  if (!response.ok) {
    throw new VpnError(`Сервер вернул ошибку ${response.status} при выдаче профиля VPN.`);
  }

  return (await response.json()) as VpnProfile;
}

export async function applyVpnProfile(profile: VpnProfile): Promise<void> {
  await invoke("vpn_set_profile", { profile });
}

export async function clearVpnProfile(): Promise<void> {
  await invoke("vpn_clear_profile");
}

export async function readVpnStatus(): Promise<VpnStatus> {
  return invoke<VpnStatus>("vpn_status");
}

export async function startVpn(): Promise<VpnStatus> {
  return invoke<VpnStatus>("vpn_start");
}

export async function stopVpn(): Promise<VpnStatus> {
  return invoke<VpnStatus>("vpn_stop");
}
