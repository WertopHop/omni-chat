/**
 * VPN bridge between the UI and the Rust side (`src-tauri/src/vpn.rs`).
 *
 * The tunnel profile is issued by the server for the current session; the UI
 * never renders keys, it only forwards them to the local sidecar.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

import type { MessageKey } from "../i18n";
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

/** Carries a dictionary key so the message is translated at render time. */
export class VpnError extends Error {
  readonly key: MessageKey;
  readonly params?: Record<string, string | number>;

  constructor(key: MessageKey, params?: Record<string, string | number>) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

/**
 * A message ready for display: either a dictionary key or raw text coming from
 * the native side (where errors are technical by design).
 */
export type VpnIssue =
  | { key: MessageKey; params?: Record<string, string | number> }
  | { text: string };

export function toVpnIssue(error: unknown): VpnIssue {
  if (error instanceof VpnError) {
    return { key: error.key, params: error.params };
  }
  if (typeof error === "string") {
    return { text: error };
  }
  if (error instanceof Error) {
    return { text: error.message };
  }
  return { key: "vpn.error.generic" };
}

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
    throw new VpnError("vpn.error.profileUnreachable");
  }

  if (response.status === 401) {
    throw new VpnError("vpn.error.sessionExpired");
  }
  if (response.status === 503) {
    throw new VpnError("vpn.error.profileMissing");
  }
  if (!response.ok) {
    throw new VpnError("vpn.error.profileStatus", { status: response.status });
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
