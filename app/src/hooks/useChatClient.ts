/**
 * Owns the stoat.js client for a signed-in session.
 *
 * Solid stores inside the SDK do not notify React, so components re-read
 * collections whenever `revision` changes (any relevant event bumps it).
 */
import { useEffect, useMemo, useState } from "react";
import { Client } from "stoat.js";

import { fetchServerInfo } from "../lib/server";
import { apiBaseUrl, type Session } from "../lib/session";

export function useChatClient(serverUrl: string, session: Session) {
  const client = useMemo(
    () => new Client({ baseURL: apiBaseUrl(serverUrl) }),
    [serverUrl],
  );

  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const bump = () => setRevision((value) => value + 1);

    const handleError = (error: unknown) => {
      console.error("chat error", error);
      const message =
        error instanceof Error ? error.message : String(error);
      setFailure(message);
    };

    client.on("ready", () => {
      setReady(true);
      bump();
    });
    client.on("connected", () => {
      setConnected(true);
      bump();
    });
    client.on("disconnected", () => setConnected(false));
    client.on("messageCreate", bump);
    client.on("messageUpdate", bump);
    client.on("error", handleError);

    // The websocket address comes from the API root payload, without it the
    // SDK would fall back to its own default host.
    (async () => {
      try {
        const info = await fetchServerInfo(serverUrl);
        if (cancelled) return;
        client.configuration = info as unknown as typeof client.configuration;
        client.useExistingSession(session);
        client.connect();
      } catch (error) {
        handleError(error);
      }
    })();

    return () => {
      cancelled = true;
      client.removeAllListeners();
      client.events.disconnect();
    };
  }, [client, serverUrl, session]);

  return { client, ready, connected, revision, failure };
}
