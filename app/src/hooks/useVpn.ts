import { useCallback, useEffect, useRef, useState } from "react";

import type { StoredAuth } from "../lib/session";
import {
  applyVpnProfile,
  fetchVpnProfile,
  readVpnStatus,
  startVpn,
  stopVpn,
  vpnAvailable,
  type VpnStatus,
} from "../lib/vpn";

const STATUS_POLL_MS = 2500;

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Не удалось управлять VPN.";
}

/**
 * Owns the local tunnel: pulls the profile for the current session once and
 * mirrors the sidecar state so the UI can show live status and logs.
 */
export function useVpn(auth: StoredAuth) {
  const available = vpnAvailable();
  const [status, setStatus] = useState<VpnStatus | null>(null);
  const [profileReady, setProfileReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const syncProfile = useCallback(async () => {
    const profile = await fetchVpnProfile(auth.serverUrl, auth.session);
    await applyVpnProfile(profile);
    setProfileReady(true);
  }, [auth.serverUrl, auth.session.token]);

  useEffect(() => {
    if (!available) return;

    let active = true;
    (async () => {
      try {
        const current = await readVpnStatus();
        if (!active) return;
        setStatus(current);
        await syncProfile();
      } catch (syncError) {
        if (active) setError(describe(syncError));
      }
    })();

    return () => {
      active = false;
    };
  }, [available, syncProfile]);

  useEffect(() => {
    if (!available) return;

    const timer = window.setInterval(async () => {
      if (busyRef.current) return;
      try {
        const current = await readVpnStatus();
        setStatus(current);
        if (current.error) setError(current.error);
      } catch {
        // The window may be closing; the next tick will retry.
      }
    }, STATUS_POLL_MS);

    return () => window.clearInterval(timer);
  }, [available]);

  const toggle = useCallback(async () => {
    if (!available || busyRef.current) return;

    busyRef.current = true;
    setBusy(true);
    setError(null);

    try {
      if (status?.running) {
        setStatus(await stopVpn());
      } else {
        if (!profileReady) await syncProfile();
        setStatus(await startVpn());
      }
    } catch (toggleError) {
      setError(describe(toggleError));
      try {
        setStatus(await readVpnStatus());
      } catch {
        // ignore: keep the last known status
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [available, profileReady, status?.running, syncProfile]);

  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      await syncProfile();
      setError(null);
    } catch (refreshError) {
      setError(describe(refreshError));
    }
  }, [available, syncProfile]);

  return {
    available,
    connected: status?.running ?? false,
    busy,
    error,
    status,
    toggle,
    refresh,
  };
}
