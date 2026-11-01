/**
 * Pieces the SDK leaves to raw API calls: invites, direct messages and friend
 * requests.
 *
 * Every helper hydrates the response into the client collections, because the
 * UI only ever reads what those collections hold.
 */
import type { Channel, Client, Server, User } from "stoat.js";

type ApiServer = { _id: string } & Record<string, unknown>;
type ApiChannel = { _id: string } & Record<string, unknown>;

type InviteJoin = {
  type: string;
  server?: ApiServer;
  channels?: ApiChannel[];
};

/**
 * The SDK types `client.api` with literal route templates, which do not survive
 * computed paths. These wrappers keep the request side plain and the response
 * side explicit.
 */
function apiGet<T>(client: Client, path: string): Promise<T> {
  return client.api.get(path as unknown as never) as unknown as Promise<T>;
}

function apiPut<T>(client: Client, path: string): Promise<T> {
  return client.api.put(
    path as unknown as never,
    undefined as unknown as never,
  ) as unknown as Promise<T>;
}

function apiPost<T>(client: Client, path: string): Promise<T> {
  return client.api.post(
    path as unknown as never,
    undefined as unknown as never,
  ) as unknown as Promise<T>;
}

/** Codes arrive pasted from chats or links, so keep the last identifier. */
export function normalizeInviteCode(input: string): string {
  const parts = input.trim().split(/[^A-Za-z0-9_-]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

/**
 * `POST /invites/{code}` consumes one use and answers with the server plus the
 * channels the newcomer may see, so no follow-up fetch is needed.
 */
export async function joinServer(client: Client, input: string): Promise<Server> {
  const code = normalizeInviteCode(input);
  if (!code) throw new Error("empty invite code");

  const data = await apiPost<InviteJoin>(client, `/invites/${code}`);
  if (data.type !== "Server" || !data.server) {
    throw new Error("not a server invite");
  }

  for (const channel of data.channels ?? []) {
    client.channels.getOrCreate(channel._id, channel as unknown as never);
  }

  return client.servers.getOrCreate(
    data.server._id,
    data.server as unknown as never,
    true,
  );
}

/** Invites hang off a channel but grant the whole server. */
export async function listInvites(
  client: Client,
  server: Server,
): Promise<string[]> {
  // The code travels as the document id.
  const invites = await apiGet<{ _id: string }[]>(
    client,
    `/servers/${server.id}/invites`,
  );
  return invites.map((invite) => invite._id);
}

export async function createInvite(channel: Channel): Promise<string> {
  const invite = await channel.createInvite();
  return invite._id;
}

/** `GET /users/<name>/dm` resolves a nickname as well as an id. */
export async function openDirectMessage(
  client: Client,
  input: string,
): Promise<Channel> {
  const name = cleanName(input);
  if (!name) throw new Error("empty nickname");

  const data = await apiGet<ApiChannel>(
    client,
    `/users/${encodeURIComponent(name)}/dm`,
  );
  const channel = client.channels.getOrCreate(data._id, data as never);
  return hydrateRecipients(client, channel);
}

/** `PUT /users/<name>/friend` links both accounts straight away. */
export async function addFriend(client: Client, input: string): Promise<User> {
  const name = cleanName(input);
  if (!name) throw new Error("empty nickname");

  const data = await apiPut<{ _id: string } & Record<string, unknown>>(
    client,
    `/users/${encodeURIComponent(name)}/friend`,
  );
  return client.users.getOrCreate(data._id, data as never);
}

/**
 * The self user carries the relationship list, but only as ids, so the friends
 * are resolved once and then show up by name on the home screen.
 */
export async function loadFriends(client: Client): Promise<void> {
  const me = await apiGet<{ relations?: { _id: string; status?: string }[] }>(
    client,
    "/users/@me",
  );
  const friends = (me.relations ?? []).filter(
    (relation) => relation.status === "Friend",
  );
  await Promise.all(
    friends.map((relation) =>
      client.users.fetch(relation._id).catch(() => undefined),
    ),
  );
}

/** Direct messages are not part of the initial sync, so fetch them once. */
export async function loadDirectMessages(client: Client): Promise<Channel[]> {
  const channels = await apiGet<ApiChannel[]>(client, "/users/dms");
  const hydrated = channels.map((data) =>
    client.channels.getOrCreate(data._id, data as never),
  );
  await Promise.all(hydrated.map((channel) => hydrateRecipients(client, channel)));
  return hydrated;
}

function cleanName(input: string): string {
  return input.trim().replace(/^@/, "");
}

/** A DM carries recipient ids only; without the users it has no display name. */
async function hydrateRecipients(
  client: Client,
  channel: Channel,
): Promise<Channel> {
  const ids = [...channel.recipientIds].filter((id) => id !== client.user?.id);
  await Promise.all(
    ids.map((id) => client.users.fetch(id).catch(() => undefined)),
  );
  return channel;
}
