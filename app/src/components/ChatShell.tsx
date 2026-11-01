import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Channel, Client, Server } from "stoat.js";

import { useChatClient } from "../hooks/useChatClient";
import { useVoice } from "../hooks/useVoice";
import { useVpn } from "../hooks/useVpn";
import { useI18n } from "../i18n";
import {
  addFriend,
  createInvite,
  joinServer,
  listInvites,
  openDirectMessage,
} from "../lib/community";
import type { StoredAuth } from "../lib/session";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Modal } from "./Modal";
import { VoiceBar } from "./VoiceBar";
import { VpnPanel } from "./VpnPanel";

type Props = {
  auth: StoredAuth;
  onLogout: () => void;
};

/**
 * One dialog at a time keeps the shell readable: the `kind` decides the body,
 * the footer and which handler runs on submit.
 */
type Dialog =
  | { kind: "server"; mode: "create" | "join" }
  | { kind: "invite" }
  | { kind: "user"; mode: "friend" | "dm" }
  | {
      kind: "confirm";
      title: string;
      body: string;
      confirm: string;
      run: () => Promise<void>;
    };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ChatShell({ auth, onLogout }: Props) {
  const { t } = useI18n();
  const { client, ready, connected, revision, failure, refresh } = useChatClient(
    auth.serverUrl,
    auth.session,
  );

  /** The home screen holds direct messages and friends, servers hold channels. */
  const [homeOpen, setHomeOpen] = useState(false);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [selectedDirectId, setSelectedDirectId] = useState<string | null>(null);

  const [vpnPanelOpen, setVpnPanelOpen] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogDraft, setDialogDraft] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [invites, setInvites] = useState<string[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);

  const vpn = useVpn(auth);
  const voice = useVoice(auth.serverUrl);

  const servers = client.servers.toList();
  const activeServer = homeOpen
    ? undefined
    : (servers.find((server) => server.id === selectedServerId) ?? servers[0]);

  // A voice channel in this backend is a text channel with a voice block, so
  // the two lists split on `isVoice` rather than on the channel type.
  const textChannels = useMemo(
    () =>
      (activeServer?.channels ?? []).filter(
        (channel) => channel.type === "TextChannel" && !channel.isVoice,
      ),
    [activeServer, revision],
  );

  const voiceChannels = useMemo(
    () => (activeServer?.channels ?? []).filter((channel) => channel.isVoice),
    [activeServer, revision],
  );

  const directChannels = useMemo(
    () =>
      client.channels.toList().filter((channel) => channel.type === "DirectMessage"),
    [client, revision],
  );

  const friends = useMemo(
    () =>
      client.users
        .toList()
        .filter(
          (user) => user.relationship === "Friend" && user.id !== client.user?.id,
        ),
    [client, revision],
  );

  const activeChannel = homeOpen
    ? (directChannels.find((channel) => channel.id === selectedDirectId) ??
      directChannels[0])
    : (textChannels.find((channel) => channel.id === selectedChannelId) ??
      textChannels[0]);

  const chatTitle = activeChannel
    ? activeChannel.type === "DirectMessage"
      ? `@ ${directLabel(activeChannel)}`
      : `# ${activeChannel.name}`
    : homeOpen
      ? t("chat.home.title")
      : t("chat.header.chooseChannel");

  function openDialog(next: Dialog, draft = "") {
    setDialogDraft(draft);
    setDialogError(null);
    setDialogBusy(false);
    setInvites(null);
    setDialog(next);
  }

  function closeDialog() {
    if (dialogBusy) return;
    setDialog(null);
    setDialogError(null);
  }

  // Invite codes are listed lazily: the dialog is short-lived and the list can
  // change while it is open.
  useEffect(() => {
    if (dialog?.kind !== "invite" || !activeServer) return;
    let cancelled = false;
    listInvites(client, activeServer)
      .then((codes) => {
        if (!cancelled) setInvites(codes);
      })
      .catch((error) => {
        if (!cancelled) setDialogError(describe(error));
      });
    return () => {
      cancelled = true;
    };
  }, [client, dialog, activeServer]);

  /** Creates a voice channel next to the existing ones without a dialog. */
  async function addVoiceChannel() {
    if (!activeServer) return;
    const taken = new Set(voiceChannels.map((channel) => channel.name));
    const base = t("voice.channelName");
    let name = base;
    for (let index = 2; taken.has(name); index += 1) name = `${base} ${index}`;
    try {
      await activeServer.createChannel({ type: "Voice", name, voice: { max_users: null } });
      refresh();
    } catch (error) {
      setChannelError(describe(error));
    }
  }

  async function addTextChannel() {
    if (!activeServer) return;
    const taken = new Set(textChannels.map((channel) => channel.name));
    const base = t("chat.channels.name");
    let name = base;
    for (let index = 2; taken.has(name); index += 1) name = `${base} ${index}`;
    try {
      await activeServer.createChannel({ type: "Text", name });
      refresh();
    } catch (error) {
      setChannelError(describe(error));
    }
  }

  /**
   * Everything in this app hangs off a server: without one a fresh account has
   * no channels and therefore no voice. The first server comes with a text
   * channel from the backend, so creating or joining one is the whole
   * onboarding.
   */
  async function submitServerDialog(event: FormEvent) {
    event.preventDefault();
    if (dialog?.kind !== "server" || dialogBusy) return;
    const value = dialogDraft.trim();
    if (!value) return;

    setDialogBusy(true);
    setDialogError(null);
    try {
      const server =
        dialog.mode === "create"
          ? await client.servers.createServer({ name: value })
          : await joinServer(client, value);
      setHomeOpen(false);
      setSelectedServerId(server.id);
      setSelectedChannelId(server.channels[0]?.id ?? null);
      setDialog(null);
      refresh();
    } catch (error) {
      setDialogError(describe(error));
    } finally {
      setDialogBusy(false);
    }
  }

  async function submitUserDialog(event: FormEvent) {
    event.preventDefault();
    if (dialog?.kind !== "user" || dialogBusy) return;
    const value = dialogDraft.trim();
    if (!value) return;

    setDialogBusy(true);
    setDialogError(null);
    try {
      if (dialog.mode === "dm") {
        const channel = await openDirectMessage(client, value);
        setHomeOpen(true);
        setSelectedDirectId(channel.id);
      } else {
        await addFriend(client, value);
      }
      setDialog(null);
      refresh();
    } catch (error) {
      setDialogError(describe(error));
    } finally {
      setDialogBusy(false);
    }
  }

  async function submitConfirmDialog() {
    if (dialog?.kind !== "confirm" || dialogBusy) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      await dialog.run();
      setDialog(null);
      refresh();
    } catch (error) {
      setDialogError(describe(error));
    } finally {
      setDialogBusy(false);
    }
  }

  /** Invites live on a text channel, so the first one issues the code. */
  async function makeInvite() {
    const channel = activeServer?.channels.find(
      (item) => item.type === "TextChannel" && !item.isVoice,
    );
    if (!channel) {
      setDialogError(t("chat.invite.noChannel"));
      return;
    }
    setDialogBusy(true);
    setDialogError(null);
    try {
      const code = await createInvite(channel);
      setInvites((current) => [code, ...(current ?? [])]);
    } catch (error) {
      setDialogError(describe(error));
    } finally {
      setDialogBusy(false);
    }
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      window.setTimeout(() => setCopied(null), 1500);
    } catch (error) {
      setDialogError(describe(error));
    }
  }

  async function startDirect(username: string) {
    try {
      const channel = await openDirectMessage(client, username);
      setHomeOpen(true);
      setSelectedDirectId(channel.id);
      refresh();
    } catch (error) {
      setChannelError(describe(error));
    }
  }

  function openMenu(event: ReactMouseEvent, items: MenuItem[]) {
    event.preventDefault();
    setMenu({
      x: Math.min(event.clientX, Math.max(0, window.innerWidth - 220)),
      y: Math.min(event.clientY, Math.max(0, window.innerHeight - 32 - items.length * 34)),
      items,
    });
  }

  function deleteChannel(channel: Channel) {
    openDialog({
      kind: "confirm",
      title: t("chat.channels.delete"),
      body: t("chat.channels.deleteQuestion", { name: channel.name ?? "" }),
      confirm: t("chat.channels.delete"),
      run: async () => {
        if (voice.channelId === channel.id) await voice.leave();
        await channel.delete();
        setSelectedChannelId((current) => (current === channel.id ? null : current));
      },
    });
  }

  function removeServer(server: Server, owned: boolean) {
    openDialog({
      kind: "confirm",
      title: owned ? t("chat.servers.delete") : t("chat.servers.leave"),
      body: owned
        ? t("chat.servers.deleteQuestion", { name: server.name })
        : t("chat.servers.leaveQuestion", { name: server.name }),
      confirm: owned ? t("chat.servers.delete") : t("chat.servers.leave"),
      run: async () => {
        // Owners delete the server for everyone, members only drop their membership.
        await server.delete(!owned);
        setSelectedServerId((current) => (current === server.id ? null : current));
        setSelectedChannelId(null);
      },
    });
  }

  function serverMenu(server: Server): MenuItem[] {
    const owned = server.ownerId === client.user?.id;
    return [
      {
        label: t("chat.invite.open"),
        onSelect: () => {
          setHomeOpen(false);
          setSelectedServerId(server.id);
          setSelectedChannelId(null);
          openDialog({ kind: "invite" });
        },
      },
      {
        label: owned ? t("chat.servers.delete") : t("chat.servers.leave"),
        danger: true,
        onSelect: () => removeServer(server, owned),
      },
    ];
  }

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-card">
          <h2>{t("chat.connecting")}</h2>
          <p>{auth.serverUrl}</p>
          {failure && <div className="error">{failure}</div>}
          <div className="boot-actions">
            <LanguageSwitcher />
            <button className="ghost" onClick={onLogout}>
              {t("chat.logout")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="rail">
        <button
          className={homeOpen ? "rail-item home active" : "rail-item home"}
          title={t("chat.home.open")}
          aria-label={t("chat.home.open")}
          onClick={() => setHomeOpen(true)}
        >
          💬
        </button>
        {servers.map((server) => (
          <button
            key={server.id}
            className={
              !homeOpen && activeServer?.id === server.id
                ? "rail-item active"
                : "rail-item"
            }
            title={server.name}
            onClick={() => {
              setHomeOpen(false);
              setSelectedServerId(server.id);
              setSelectedChannelId(null);
            }}
            onContextMenu={(event) => openMenu(event, serverMenu(server))}
          >
            {server.name.slice(0, 2)}
          </button>
        ))}
        <button
          className="rail-item add"
          title={t("chat.servers.add")}
          aria-label={t("chat.servers.add")}
          onClick={() => openDialog({ kind: "server", mode: "create" })}
        >
          +
        </button>
      </nav>

      <aside className="channels">
        <header className="channels-header">
          <span className="channels-title">
            {homeOpen ? t("chat.home.title") : (activeServer?.name ?? t("chat.servers.none"))}
          </span>
          {!homeOpen && activeServer && (
            <button
              type="button"
              className="ghost small"
              onClick={() => openDialog({ kind: "invite" })}
            >
              {t("chat.invite.open")}
            </button>
          )}
        </header>

        <div className="channel-list">
          {homeOpen && (
            <>
              <div className="channel-divider">
                <span>{t("chat.friends.title")}</span>
                <button
                  type="button"
                  className="ghost small"
                  title={t("chat.friends.add")}
                  aria-label={t("chat.friends.add")}
                  onClick={() => openDialog({ kind: "user", mode: "friend" })}
                >
                  +
                </button>
              </div>
              {friends.map((friend) => (
                <button
                  key={friend.id}
                  className="channel"
                  onClick={() => void startDirect(friend.username)}
                >
                  <span className="hash">@</span>
                  {friend.displayName}
                </button>
              ))}
              {friends.length === 0 && (
                <p className="empty">{t("chat.friends.empty")}</p>
              )}

              <div className="channel-divider">
                <span>{t("chat.direct.title")}</span>
                <button
                  type="button"
                  className="ghost small"
                  title={t("chat.direct.new")}
                  aria-label={t("chat.direct.new")}
                  onClick={() => openDialog({ kind: "user", mode: "dm" })}
                >
                  +
                </button>
              </div>
              {directChannels.map((channel) => (
                <button
                  key={channel.id}
                  className={
                    activeChannel?.id === channel.id ? "channel active" : "channel"
                  }
                  onClick={() => setSelectedDirectId(channel.id)}
                >
                  <span className="hash">@</span>
                  {directLabel(channel)}
                </button>
              ))}
              {directChannels.length === 0 && (
                <p className="empty">{t("chat.direct.empty")}</p>
              )}
            </>
          )}

          {!homeOpen && !activeServer && (
            <div className="server-create">
              <p className="empty">{t("chat.servers.empty")}</p>
              <button
                className="primary"
                onClick={() => openDialog({ kind: "server", mode: "create" })}
              >
                {t("chat.servers.create")}
              </button>
              <button
                className="ghost"
                onClick={() => openDialog({ kind: "server", mode: "join" })}
              >
                {t("chat.servers.join")}
              </button>
            </div>
          )}

          {!homeOpen && activeServer && (
            <>
              <div className="channel-divider">
                <span>{t("chat.channels.title")}</span>
                <button
                  type="button"
                  className="ghost small"
                  title={t("chat.channels.add")}
                  aria-label={t("chat.channels.add")}
                  onClick={() => void addTextChannel()}
                >
                  +
                </button>
              </div>

              {textChannels.map((channel) => (
                <button
                  key={channel.id}
                  className={
                    activeChannel?.id === channel.id ? "channel active" : "channel"
                  }
                  onClick={() => setSelectedChannelId(channel.id)}
                  onContextMenu={(event) =>
                    openMenu(event, [
                      {
                        label: t("chat.channels.delete"),
                        danger: true,
                        onSelect: () => deleteChannel(channel),
                      },
                    ])
                  }
                >
                  <span className="hash">#</span>
                  {channel.name}
                </button>
              ))}

              {textChannels.length === 0 && (
                <p className="empty">{t("chat.channels.empty")}</p>
              )}

              <div className="channel-divider">
                <span>{t("voice.title")}</span>
                <button
                  type="button"
                  className="ghost small"
                  title={t("voice.addChannel")}
                  aria-label={t("voice.addChannel")}
                  onClick={() => void addVoiceChannel()}
                >
                  +
                </button>
              </div>
              {voiceChannels.map((channel) => {
                const inHere = voice.channelId === channel.id;
                return (
                  <button
                    key={channel.id}
                    className={inHere ? "channel voice joined" : "channel voice"}
                    title={inHere ? t("voice.leave") : t("voice.join")}
                    onClick={() =>
                      inHere ? void voice.leave() : void voice.join(channel)
                    }
                    onContextMenu={(event) =>
                      openMenu(event, [
                        {
                          label: t("chat.channels.delete"),
                          danger: true,
                          onSelect: () => deleteChannel(channel),
                        },
                      ])
                    }
                  >
                    <span className="hash">{inHere ? "🔊" : "🔈"}</span>
                    {channel.name}
                  </button>
                );
              })}
              {voiceChannels.length === 0 && (
                <p className="empty">{t("voice.channels.empty")}</p>
              )}
            </>
          )}
        </div>

        <VoiceBar voice={voice} />

        <footer className="user-panel">
          <div className="avatar">
            {(client.user?.username ?? "?").slice(0, 2)}
          </div>
          <div className="user-name">{client.user?.username ?? "…"}</div>
          <button className="ghost small" onClick={onLogout} title={t("chat.logout")}>
            ⎋
          </button>
        </footer>
      </aside>

      <main className="chat">
        <header className="chat-header">
          <span className="chat-title">{chatTitle}</span>
          <span className={connected ? "chip ok" : "chip"}>
            {connected ? t("chat.status.online") : t("chat.status.reconnecting")}
          </span>
          <LanguageSwitcher className="compact" />
          <button
            className={vpn.connected ? "chip vpn on" : "chip vpn"}
            title={t("vpn.chip.title")}
            onClick={() => setVpnPanelOpen((open) => !open)}
          >
            {t("vpn.chip", {
              state: vpn.connected
                ? t("vpn.state.connected")
                : vpn.reconnecting
                  ? t("vpn.state.reconnecting")
                  : vpn.busy
                    ? t("vpn.chip.busy")
                    : t("vpn.state.disabled"),
            })}
          </button>
        </header>

        {vpnPanelOpen && <VpnPanel vpn={vpn} onClose={() => setVpnPanelOpen(false)} />}

        {failure && <div className="banner">{failure}</div>}
        {channelError && <div className="banner">{channelError}</div>}

        {activeChannel ? (
          <>
            <MessageList client={client} channel={activeChannel} revision={revision} />
            <Composer channel={activeChannel} />
          </>
        ) : (
          <div className="placeholder">
            {homeOpen ? t("chat.direct.pick") : t("chat.placeholder")}
          </div>
        )}
      </main>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}

      {dialog?.kind === "server" && (
        <Modal
          title={
            dialog.mode === "create"
              ? t("chat.servers.create")
              : t("chat.servers.join")
          }
          busy={dialogBusy}
          onClose={closeDialog}
          onSubmit={(event) => void submitServerDialog(event)}
          footer={
            <>
              <button
                type="button"
                className="ghost"
                disabled={dialogBusy}
                onClick={closeDialog}
              >
                {t("chat.common.cancel")}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={!dialogDraft.trim() || dialogBusy}
              >
                {dialogBusy
                  ? t("chat.common.busy")
                  : dialog.mode === "create"
                    ? t("chat.servers.createSubmit")
                    : t("chat.servers.joinSubmit")}
              </button>
            </>
          }
        >
          <label className="field">
            <span>
              {dialog.mode === "create"
                ? t("chat.servers.nameLabel")
                : t("chat.servers.inviteLabel")}
            </span>
            <input
              autoFocus
              maxLength={120}
              value={dialogDraft}
              placeholder={
                dialog.mode === "create"
                  ? t("chat.servers.namePlaceholder")
                  : t("chat.servers.invitePlaceholder")
              }
              onChange={(event) => setDialogDraft(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="link"
            onClick={() => {
              setDialogDraft("");
              setDialogError(null);
              setDialog({
                kind: "server",
                mode: dialog.mode === "create" ? "join" : "create",
              });
            }}
          >
            {dialog.mode === "create"
              ? t("chat.servers.haveInvite")
              : t("chat.servers.createInstead")}
          </button>
          {dialogError && <div className="error">{dialogError}</div>}
        </Modal>
      )}

      {dialog?.kind === "invite" && (
        <Modal
          title={t("chat.invite.title")}
          busy={dialogBusy}
          onClose={closeDialog}
          footer={
            <>
              <button
                type="button"
                className="ghost"
                disabled={dialogBusy}
                onClick={closeDialog}
              >
                {t("chat.common.close")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={dialogBusy}
                onClick={() => void makeInvite()}
              >
                {dialogBusy ? t("chat.common.busy") : t("chat.invite.create")}
              </button>
            </>
          }
        >
          <p className="hint">{t("chat.invite.hint")}</p>
          {invites === null && <p className="empty">{t("chat.common.loading")}</p>}
          {invites !== null && invites.length === 0 && (
            <p className="empty">{t("chat.invite.empty")}</p>
          )}
          {invites !== null && invites.length > 0 && (
            <ul className="invite-list">
              {invites.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => void copyCode(code)}
                  >
                    {copied === code ? t("chat.invite.copied") : t("chat.invite.copy")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {dialogError && <div className="error">{dialogError}</div>}
        </Modal>
      )}

      {dialog?.kind === "user" && (
        <Modal
          title={
            dialog.mode === "friend" ? t("chat.friends.add") : t("chat.direct.new")
          }
          busy={dialogBusy}
          onClose={closeDialog}
          onSubmit={(event) => void submitUserDialog(event)}
          footer={
            <>
              <button
                type="button"
                className="ghost"
                disabled={dialogBusy}
                onClick={closeDialog}
              >
                {t("chat.common.cancel")}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={!dialogDraft.trim() || dialogBusy}
              >
                {dialogBusy
                  ? t("chat.common.busy")
                  : dialog.mode === "friend"
                    ? t("chat.friends.add")
                    : t("chat.direct.open")}
              </button>
            </>
          }
        >
          <label className="field">
            <span>{t("chat.user.username")}</span>
            <input
              autoFocus
              maxLength={32}
              value={dialogDraft}
              placeholder={t("chat.user.usernamePlaceholder")}
              onChange={(event) => setDialogDraft(event.target.value)}
            />
          </label>
          <p className="hint">
            {dialog.mode === "friend" ? t("chat.friends.hint") : t("chat.direct.hint")}
          </p>
          {dialogError && <div className="error">{dialogError}</div>}
        </Modal>
      )}

      {dialog?.kind === "confirm" && (
        <Modal
          title={dialog.title}
          busy={dialogBusy}
          onClose={closeDialog}
          footer={
            <>
              <button
                type="button"
                className="ghost"
                disabled={dialogBusy}
                onClick={closeDialog}
              >
                {t("chat.common.cancel")}
              </button>
              <button
                type="button"
                className="primary danger"
                disabled={dialogBusy}
                onClick={() => void submitConfirmDialog()}
              >
                {dialog.confirm}
              </button>
            </>
          }
        >
          <p className="hint">{dialog.body}</p>
          {dialogError && <div className="error">{dialogError}</div>}
        </Modal>
      )}
    </div>
  );
}

function directLabel(channel: Channel): string {
  return channel.displayName ?? channel.name ?? channel.id;
}

function MessageList({
  client,
  channel,
  revision,
}: {
  client: Client;
  channel: Channel;
  revision: number;
}) {
  const { t, intlLocale } = useI18n();

  useEffect(() => {
    channel.fetchMessages({ limit: 50 }).catch((error) => {
      console.error("failed to load history", error);
    });
  }, [channel]);

  const messages = useMemo(() => {
    return client.messages
      .toList()
      .filter((message) => message.channelId === channel.id)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }, [client, channel, revision]);

  return (
    <div className="messages">
      {messages.map((message) => (
        <article className="message" key={message.id}>
          <div className="message-meta">
            <span className="message-author">
              {message.author?.username ?? t("chat.messages.unknownAuthor")}
            </span>
            <time>{message.createdAt.toLocaleString(intlLocale)}</time>
          </div>
          <div className="message-body">{message.content}</div>
        </article>
      ))}

      {messages.length === 0 && (
        <p className="empty">{t("chat.messages.empty")}</p>
      )}
    </div>
  );
}

function Composer({ channel }: { channel: Channel }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const content = draft.trim();
    if (!content || sending) return;

    setSending(true);
    setDraft("");

    try {
      await channel.sendMessage(content);
    } catch (error) {
      console.error("failed to send", error);
      setDraft(content);
    } finally {
      setSending(false);
    }
  }

  const label = channel.displayName ?? channel.name ?? "";
  const placeholder =
    channel.type === "DirectMessage"
      ? t("chat.composer.placeholderDirect", { channel: label })
      : t("chat.composer.placeholder", { channel: label });

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
        placeholder={placeholder}
        rows={1}
      />
      <button className="primary" type="submit" disabled={!draft.trim() || sending}>
        {t("chat.composer.send")}
      </button>
    </form>
  );
}
