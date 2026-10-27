import { useCallback, useState } from "react";

import { ChatShell } from "./components/ChatShell";
import { LoginScreen } from "./components/LoginScreen";
import {
  clearAuth,
  loadAuth,
  saveAuth,
  type StoredAuth,
} from "./lib/session";

export default function App() {
  const [auth, setAuth] = useState<StoredAuth | null>(() => loadAuth());

  const handleAuthenticated = useCallback((next: StoredAuth) => {
    saveAuth(next);
    setAuth(next);
  }, []);

  const handleLogout = useCallback(() => {
    clearAuth();
    setAuth(null);
  }, []);

  if (!auth) {
    return <LoginScreen onAuthenticated={handleAuthenticated} />;
  }

  return (
    <ChatShell
      key={`${auth.serverUrl}:${auth.session.user_id}`}
      auth={auth}
      onLogout={handleLogout}
    />
  );
}
