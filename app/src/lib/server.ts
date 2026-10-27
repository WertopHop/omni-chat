/**
 * Server bootstrap config.
 *
 * The SDK needs the API root payload before it can open the websocket: the
 * `ws` address is taken from it. stoat.js 7.3.6 has no initConfig(), so the
 * payload is fetched here and handed to the client explicitly.
 */
import { apiBaseUrl } from "./session";

export type ServerInfo = {
  ws?: string;
  app?: string;
  api?: string;
  revolt?: string;
  features?: unknown;
  [key: string]: unknown;
};

export async function fetchServerInfo(serverUrl: string): Promise<ServerInfo> {
  const response = await fetch(`${apiBaseUrl(serverUrl)}/`);
  if (!response.ok) {
    // Technical detail: shown verbatim in the connection banner.
    throw new Error(`API root request failed: HTTP ${response.status}`);
  }
  return (await response.json()) as ServerInfo;
}
