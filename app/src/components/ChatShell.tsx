import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Channel, Client } from "stoat.js";

import { useChatClient } from "../hooks/useChatClient";
import { useVoice } from "../hooks/useVoice";
import { useVpn } from "../hooks/useVpn";
import { useI18n } from "../i18n";
import type { StoredAuth } from "../lib/session";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { VoiceBar } from "./VoiceBar";
import { VpnPanel } from "./VpnPanel";

type Props = {
  auth: StoredAuth;
  onLogout: () => void;
};

export function ChatShell({ auth, onLogout }: Props) {
  const { t } = useI18n();
  const { client, ready, connected, revision, failure, refresh } = useChatClient(
    auth.serverUrl,
    auth.session,
  );

  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [vpnPanelOpen, setVpnPanelOpen] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [serverDialogOpen, setServerDialogOpen] = useState(false);
  const [serverDraft, setServerDraft] = useState("");
  const [serverBusy, setServerBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const vpn = useVpn(auth);
  const voice = useVoice(auth.serverUrl);

  const servers = client.servers.toList();
  const activeServer =
    servers.find((server) => server.id === selectedServerId) ?? servers[0];

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

  const activeChannel =
    textChannels.find((channel) => channel.id === selectedChannelId) ?? textChannels[0];

  /** Creates a voice channel next to the existing ones without a dialog. */
  async function addVoiceChannel() {
    if (!activeServer) return;
    const taken = new Set(voiceChannels.map((channel) => channel.name));
    const base = t("voice.channelName");
    let name = base;
    for (let index = 2; taken.has(name); index += 1) name = `${base} ${index}`;
    try {
      await activeServer.createChannel({ type: "Voice", name, voice: { max_users: null } });
    } catch (error) {
      setChannelError(error instanceof Error ? error.message : String(error));
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
      setChannelError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Everything in the app hangs off a server: without one a fresh account has
   * no channels and therefore no voice. The first server comes with a text
   * channel from the backend, so creating it is the whole onboarding.
   */
  async function createServer(event: FormEvent) {
    event.preventDefault();
    const name = serverDraft.trim();
    if (!name || serverBusy) return;

    setServerBusy(true);
    setServerError(null);
    try {
      const created = await client.servers.createServer({ name });
      setSelectedServerId(created.id);
      setSelectedChannelId(created.channels[0]?.id ?? null);
      setServerDialogOpen(false);
      setServerDraft("");
      refresh();
    } catch (error) {
      setServerError(error instanceof Error ? error.message : String(error));
    } finally {
      setServerBusy(false);
    }
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
        {servers.map((server) => (
          <button
            key={server.id}
            className={
              activeServer?.id === server.id ? "rail-item active" : "rail-item"
            }
            title={server.name}
            onClick={() => {
              setSelectedServerId(server.id);
              setSelectedChannelId(null);
            }}
          >
            {server.name.slice(0, 2)}
          </button>
        ))}
        <button
          className="rail-item add"
          title={t("chat.servers.create")}
          aria-label={t("chat.servers.create")}
          onClick={() => {
            setServerError(null);
            setServerDialogOpen(true);
          }}
        >
          +
        </button>
      </nav>

      <aside className="channels">
        <header className="channels-header">
          {activeServer?.name ?? t("chat.servers.none")}
        </header>

        <div className="channel-list">
          {!activeServer && (
            <div className="server-create">
              <p className="empty">{t("chat.servers.empty")}</p>
              <button
                className="primary"
                onClick={() => {
                  setServerError(null);
                  setServerDialogOpen(true);
                }}
              >
                {t("chat.servers.create")}
              </button>
            </div>
          )}

          {activeServer && (
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
          )}

          {textChannels.map((channel) => (
            <button
              key={channel.id}
              className={
                activeChannel?.id === channel.id ? "channel active" : "channel"
              }
              onClick={() => setSelectedChannelId(channel.id)}
            >
              <span className="hash">#</span>
              {channel.name}
            </button>
          ))}

          {activeServer && textChannels.length === 0 && (
            <p className="empty">{t("chat.channels.empty")}</p>
          )}

          {activeServer && (
            <>
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
                    onClick={() => (inHere ? void voice.leave() : void voice.join(channel))}
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
          <span className="chat-title">
            {activeChannel
              ? `# ${activeChannel.name}`
              : t("chat.header.chooseChannel")}
          </span>
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
          <div className="placeholder">{t("chat.placeholder")}</div>
        )}
      </main>

      {serverDialogOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!serverBusy) setServerDialogOpen(false);
          }}
        >
          <form
            className="modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => void createServer(event)}
          >
            <h3>{t("chat.servers.create")}</h3>
            <label className="field">
              <span>{t("chat.servers.nameLabel")}</span>
              <input
                autoFocus
                maxLength={64}
                value={serverDraft}
                placeholder={t("chat.servers.namePlaceholder")}
                onChange={(event) => setServerDraft(event.target.value)}
              />
            </label>
            {serverError && <div className="error">{serverError}</div>}
            <div className="modal-actions">
              <button
                type="button"
                className="ghost"
                disabled={serverBusy}
                onClick={() => setServerDialogOpen(false)}
              >
                {t("chat.servers.cancel")}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={!serverDraft.trim() || serverBusy}
              >
                {serverBusy ? t("chat.servers.creating") : t("chat.servers.createSubmit")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
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
        placeholder={t("chat.composer.placeholder", { channel: channel.name })}
        rows={1}
      />
      <button className="primary" type="submit" disabled={!draft.trim() || sending}>
        {t("chat.composer.send")}
      </button>
    </form>
  );
}
