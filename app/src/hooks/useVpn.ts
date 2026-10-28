import { useCallback, useEffect, useRef, useState } from "react";

import type { StoredAuth } from "../lib/session";
import {
  applyVpnProfile,
  fetchVpnProfile,
  readVpnStatus,
  setVpnMode,
  startVpn,
  stopVpn,
  toVpnIssue,
  vpnAvailable,
  type VpnIssue,
  type VpnMode,
  type VpnStatus,
} from "../lib/vpn";

const STATUS_POLL_MS = 2500;
/**
 * Reconnect back-off after an unexpected drop. Once the attempts run out the
 * tunnel stays off until the user asks again, so a dead server does not turn
 * into a loop of prompts.
 */
const RECONNECT_DELAYS_MS = [2000, 5000, 10000];

/**
 * Owns the local tunnel: pulls the profile for the current session, mirrors the
 * sidecar state, and brings the tunnel back after a drop or a network switch.
 */
export function useVpn(auth: StoredAuth) {
  const available = vpnAvailable();
  const [status, setStatus] = useState<VpnStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [issue, setIssue] = useState<VpnIssue | null>(null);

  const statusRef = useRef<VpnStatus | null>(null);
  const busyRef = useRef(false);
  const reconnectingRef = useRef(false);
  const profileReadyRef = useRef(false);
  /** What the user asked for, which outlives a drop. */
  const desiredRef = useRef(false);
  const attemptsRef = useRef(0);

  const apply = useCallback((next: VpnStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const syncProfile = useCallback(async () => {
    const profile = await fetchVpnProfile(auth.serverUrl, auth.session);
    await applyVpnProfile(profile);
    profileReadyRef.current = true;
  }, [auth.serverUrl, auth.session.token]);

  const connect = useCallback(async () => {
    if (!profileReadyRef.current) await syncProfile();
    const next = await startVpn();
    attemptsRef.current = 0;
    apply(next);
  }, [apply, syncProfile]);

  const reconnect = useCallback(async () => {
    if (!available || busyRef.current || reconnectingRef.current) return;
    const attempt = attemptsRef.current;
    if (attempt >= RECONNECT_DELAYS_MS.length) return;

    reconnectingRef.current = true;
    attemptsRef.current = attempt + 1;
    setReconnecting(true);
    try {
      await new Promise((resolve) => window.setTimeout(resolve, RECONNECT_DELAYS_MS[attempt]));
      if (!desiredRef.current) return;
      await connect();
      setIssue(null);
    } catch (error) {
      setIssue(toVpnIssue(error));
    } finally {
      reconnectingRef.current = false;
      setReconnecting(false);
    }
  }, [available, connect]);

  useEffect(() => {
    if (!available) return;

    let active = true;
    (async () => {
      try {
        const current = await readVpnStatus();
        if (!active) return;
        apply(current);
        desiredRef.current = current.running;
        await syncProfile();
      } catch (syncError) {
        if (active) setIssue(toVpnIssue(syncError));
      }
    })();

    return () => {
      active = false;
    };
  }, [available, apply, syncProfile]);

  useEffect(() => {
    if (!available) return;

    const timer = window.setInterval(async () => {
      if (busyRef.current) return;
      try {
        const current = await readVpnStatus();
        apply(current);
        if (current.error) setIssue({ text: current.error });
        if (!current.running && desiredRef.current) void reconnect();
      } catch {
        // The window may be closing; the next tick will retry.
      }
    }, STATUS_POLL_MS);

    // Switching networks drops the tunnel; come back as soon as the link does.
    const onOnline = () => {
      if (desiredRef.current) void reconnect();
    };
    window.addEventListener("online", onOnline);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [available, apply, reconnect]);

  const toggle = useCallback(async () => {
    if (!available || busyRef.current) return;

    busyRef.current = true;
    setBusy(true);
    setIssue(null);
    desiredRef.current = !(statusRef.current?.running ?? false);

    try {
      if (desiredRef.current) {
        await connect();
      } else {
        attemptsRef.current = 0;
        apply(await stopVpn());
      }
    } catch (toggleError) {
      desiredRef.current = false;
      setIssue(toVpnIssue(toggleError));
      try {
        apply(await readVpnStatus());
      } catch {
        // keep the last known status
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [available, apply, connect]);

  const changeMode = useCallback(
    async (mode: VpnMode) => {
      if (!available || busyRef.current) return;

      busyRef.current = true;
      setBusy(true);
      setIssue(null);
      const wasWanted = desiredRef.current;

      try {
        apply(await setVpnMode(mode));
        // The native side stops the tunnel on a mode switch, so bring it back.
        if (wasWanted) await connect();
      } catch (modeError) {
        setIssue(toVpnIssue(modeError));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [available, apply, connect],
  );

  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      await syncProfile();
      setIssue(null);
    } catch (refreshError) {
      setIssue(toVpnIssue(refreshError));
    }
  }, [available, syncProfile]);

  return {
    available,
    mode: status?.mode ?? "proxy",
    connected: status?.running ?? false,
    elevated: status?.elevated ?? false,
    tunName: status?.tun_name ?? null,
    busy,
    reconnecting,
    issue,
    status,
    toggle,
    setMode: changeMode,
    refresh,
  };
}
