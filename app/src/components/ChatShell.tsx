import { useEffect, useMemo, useState } from "react";
import type { Channel, Client } from "stoat.js";

import { useChatClient } from "../hooks/useChatClient";
import { useVpn } from "../hooks/useVpn";
import type { StoredAuth } from "../lib/session";
import { VpnPanel } from "./VpnPanel";

type Props = {
  auth: StoredAuth;
  onLogout: () => void;
};

export function ChatShell({ auth, onLogout }: Props) {
  const { client, ready, connected, revision, failure } = useChatClient(
    auth.serverUrl,
    auth.session,
  );

  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [vpnPanelOpen, setVpnPanelOpen] = useState(false);
  const vpn = useVpn(auth);

  const servers = client.servers.toList();
  const activeServer =
    servers.find((server) => server.id === selectedServerId) ?? servers[0];

  const textChannels = useMemo(
    () => (activeServer?.channels ?? []).filter((channel) => channel.type === "TextChannel"),
    [activeServer, revision],
  );

  const activeChannel =
    textChannels.find((channel) => channel.id === selectedChannelId) ?? textChannels[0];

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-card">
          <h2>Подключаемся к серверу…</h2>
          <p>{auth.serverUrl}</p>
          {failure && <div className="error">{failure}</div>}
          <button className="ghost" onClick={onLogout}>
            Выйти
          </button>
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
      </nav>

      <aside className="channels">
        <header className="channels-header">
          {activeServer?.name ?? "Нет серверов"}
        </header>

        <div className="channel-list">
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
            <p className="empty">Нет текстовых каналов</p>
          )}
          {!activeServer && <p className="empty">Вы пока не в одном сервере</p>}
        </div>

        <footer className="user-panel">
          <div className="avatar">
            {(client.user?.username ?? "?").slice(0, 2)}
          </div>
          <div className="user-name">{client.user?.username ?? "…"}</div>
          <button className="ghost small" onClick={onLogout} title="Выйти">
            ⎋
          </button>
        </footer>
      </aside>

      <main className="chat">
        <header className="chat-header">
          <span className="chat-title">
            {activeChannel ? `# ${activeChannel.name}` : "Выберите канал"}
          </span>
          <span className={connected ? "chip ok" : "chip"}>
            {connected ? "на связи" : "переподключение"}
          </span>
          <button
            className={vpn.connected ? "chip vpn on" : "chip vpn"}
            title="Управление туннелем"
            onClick={() => setVpnPanelOpen((open) => !open)}
          >
            VPN: {vpn.connected ? "вкл" : vpn.busy ? "…" : "выкл"}
          </button>
        </header>

        {vpnPanelOpen && <VpnPanel vpn={vpn} onClose={() => setVpnPanelOpen(false)} />}

        {failure && <div className="banner">{failure}</div>}

        {activeChannel ? (
          <>
            <MessageList client={client} channel={activeChannel} revision={revision} />
            <Composer channel={activeChannel} />
          </>
        ) : (
          <div className="placeholder">Выберите канал</div>
        )}
      </main>
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
              {message.author?.username ?? "неизвестный"}
            </span>
            <time>{message.createdAt.toLocaleString()}</time>
          </div>
          <div className="message-body">{message.content}</div>
        </article>
      ))}

      {messages.length === 0 && (
        <p className="empty">Пока пусто. Напишите первым.</p>
      )}
    </div>
  );
}

function Composer({ channel }: { channel: Channel }) {
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
        placeholder={`Сообщение в #${channel.name}`}
        rows={1}
      />
      <button className="primary" type="submit" disabled={!draft.trim() || sending}>
        Отправить
      </button>
    </form>
  );
}
