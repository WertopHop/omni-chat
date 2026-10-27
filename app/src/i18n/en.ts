/**
 * English dictionary: the source of truth for every UI string.
 *
 * Keys are flat and namespaced by screen. To add a language, copy this file,
 * translate the values, and register the result in `dictionaries` of
 * `./index.tsx`; the type checker reports any missing or extra key.
 * Placeholders look like `{name}` and are substituted by `t(key, params)`.
 */
export const en = {
  "app.name": "omni-chat",
  "app.tagline": "A private server for your circle",

  "language.label": "Language",
  "language.en": "English",
  "language.ru": "Русский",

  "login.tab.signIn": "Sign in",
  "login.tab.register": "Sign up",
  "login.server.label": "Server address",
  "login.server.checking": "Checking the server…",
  "login.server.online": "Server is reachable",
  "login.server.onlineWithVersion": "Server is reachable ({version})",
  "login.server.offline": "Server is not responding",
  "login.username": "Nickname",
  "login.password": "Password",
  "login.invite": "Invite code",
  "login.invitePlaceholder": "issued by the administrator",
  "login.submit.signIn": "Sign in",
  "login.submit.register": "Create account",
  "login.submit.busy": "Please wait…",
  "login.inviteHint":
    "An account needs an invite code: the server is closed and access is granted by the administrator.",
  "login.error.missingServer": "Enter the server address.",
  "login.error.missingCredentials": "Fill in the nickname and the password.",

  "chat.connecting": "Connecting to the server…",
  "chat.logout": "Sign out",
  "chat.servers.none": "No servers",
  "chat.channels.empty": "No text channels",
  "chat.servers.empty": "You are not in any server yet",
  "chat.header.chooseChannel": "Select a channel",
  "chat.status.online": "connected",
  "chat.status.reconnecting": "reconnecting",
  "chat.placeholder": "Select a channel",
  "chat.messages.empty": "Nothing here yet. Say hi first.",
  "chat.messages.unknownAuthor": "unknown",
  "chat.composer.placeholder": "Message # {channel}",
  "chat.composer.send": "Send",

  "vpn.chip": "VPN: {state}",
  "vpn.chip.busy": "…",
  "vpn.chip.title": "Tunnel settings",
  "vpn.title": "Tunnel",
  "vpn.close": "Close",
  "vpn.unavailable":
    "The VPN runs only in the desktop application: the profile and the tunnel live in the native part of the client.",
  "vpn.modeNote":
    "Proxy mode: a local SOCKS/HTTP proxy and the system proxy. Full-traffic control and per-app rules come later.",
  "vpn.fact.state": "State",
  "vpn.fact.server": "Server",
  "vpn.fact.socks": "Local SOCKS",
  "vpn.fact.systemProxy": "System proxy",
  "vpn.fact.uptime": "Uptime",
  "vpn.state.connected": "connected",
  "vpn.state.connecting": "connecting…",
  "vpn.state.disabled": "off",
  "vpn.systemProxy.on": "on",
  "vpn.systemProxy.off": "off",
  "vpn.action.connect": "Turn on VPN",
  "vpn.action.disconnect": "Turn off",
  "vpn.action.busy": "Connecting…",
  "vpn.action.refresh": "Refresh profile",
  "vpn.uptime.seconds": "{count} s",
  "vpn.uptime.minutes": "{count} min",
  "vpn.uptime.hours": "{hours} h {minutes} min",

  "errors.common.dash": "—",
  "errors.invalidCredentials": "Wrong nickname or password.",
  "errors.missingInvite": "An invite code from the administrator is required.",
  "errors.invalidInvite": "The invite code is wrong or already used.",
  "errors.usernameTaken": "This nickname is already taken.",
  "errors.invalidUsername":
    "Nickname: 2-32 characters, letters, digits, dot, dash or underscore.",
  "errors.shortPassword": "The password must be at least 8 characters long.",
  "errors.compromisedPassword": "This password leaked too often, choose another one.",
  "errors.failedValidation": "The server rejected the data.",
  "errors.invalidSession": "The server did not return a session.",
  "errors.unreachable": "Server is unavailable: check the address and the connection.",
  "errors.server": "Server error: {kind}",
  "errors.raw": "{message}",
  "errors.unknown": "Something went wrong.",

  "vpn.error.profileUnreachable": "Server is unreachable: cannot fetch the VPN profile.",
  "vpn.error.sessionExpired": "Session expired: sign in again to get the VPN profile.",
  "vpn.error.profileMissing":
    "The server has no VPN profile (check generated/client-profile.json).",
  "vpn.error.profileStatus": "The server returned {status} while issuing the VPN profile.",
  "vpn.error.generic": "Could not control the VPN.",
} as const;

export type MessageKey = keyof typeof en;
