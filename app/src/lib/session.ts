/**
 * Persisted authentication state.
 *
 * The session token is stored in the webview storage for now; moving it to the
 * OS keyring (Tauri stronghold) is planned together with the VPN credentials.
 */
export type Session = {
  _id: string;
  token: string;
  user_id: string;
  name?: string;
};

export type StoredAuth = {
  serverUrl: string;
  session: Session;
};

const STORAGE_KEY = "omni-chat.auth";

export function loadAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as StoredAuth;
    if (!parsed?.serverUrl || !parsed?.session?.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveAuth(auth: StoredAuth): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
}

export function clearAuth(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Turns user input like `chat.example.com/` into `https://chat.example.com`. */
export function normalizeServerUrl(input: string): string {
  let value = input.trim();
  if (!value) return "";

  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  return value.replace(/\/+$/, "");
}

export function apiBaseUrl(serverUrl: string): string {
  return `${normalizeServerUrl(serverUrl)}/api`;
}
