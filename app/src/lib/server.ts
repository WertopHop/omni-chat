/**
 * Server bootstrap config.
 *
 * The SDK needs the API root payload before it can open the websocket: the
 * `ws` address is taken from it. stoat.js 7.3.6 has no initConfig(), so the
 * payload is fetched here and handed to the client explicitly.
 */
import { apiBaseUrl } from "./session";

export type VoiceNode = {
  name: string;
  lat?: number;
  lon?: number;
  public_url?: string;
};

/** The API root lists capabilities under `features`. */
type Features = {
  livekit?: { enabled?: boolean; nodes?: VoiceNode[] };
};

export type ServerInfo = {
  ws?: string;
  app?: string;
  api?: string;
  revolt?: string;
  features?: Features;
  [key: string]: unknown;
};

export function voiceNodes(info: ServerInfo): VoiceNode[] {
  return info.features?.livekit?.nodes ?? [];
}

/**
 * A join token is signed for a named node and the backend rejects the request
 * without one, so the client takes the name from the API root. A self-hosted
 * stack has a single node, and the list already arrives ordered.
 */
export function voiceNodeName(info: ServerInfo): string | null {
  return voiceNodes(info).find((node) => node?.name)?.name ?? null;
}

export async function fetchServerInfo(serverUrl: string): Promise<ServerInfo> {
  const response = await fetch(`${apiBaseUrl(serverUrl)}/`);
  if (!response.ok) {
    // Technical detail: shown verbatim in the connection banner.
    throw new Error(`API root request failed: HTTP ${response.status}`);
  }
  return (await response.json()) as ServerInfo;
}
