/**
 * Owns the voice room for the current session.
 *
 * A call is independent of the text channel selection: joining a voice channel
 * leaves the previously joined one, and closing the app disconnects. Audio
 * playback is started from the join gesture, because a webview may refuse to
 * play sound before the user interacts with the page.
 *
 * Devices, per-participant volume and the microphone meter are part of the same
 * hook because they all need the live room: the selection drives the next join
 * and is applied to the current call through `switchActiveDevice`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import type { Channel } from "stoat.js";

import type { MessageKey } from "../i18n";
import { fetchServerInfo, voiceNodeName } from "../lib/server";
import {
  applyPeerVolumes,
  listAudioDevices,
  setPeerVolume as setRoomPeerVolume,
  voicePeers,
  watchMicLevel,
  type AudioDevice,
  type AudioDevices,
  type VoicePeer,
} from "../lib/voice";

export type VoiceStatus = "idle" | "connecting" | "connected";

export type VoiceState = {
  status: VoiceStatus;
  channelId: string | null;
  channelName: string;
  muted: boolean;
  deafened: boolean;
  peers: VoicePeer[];
  /** True when the webview blocked playback until the user asks for it. */
  audioBlocked: boolean;
  error: MessageKey | null;
  /** Microphone peak level, 0..1; zero while muted or not in a call. */
  micLevel: number;
};

const IDLE: VoiceState = {
  status: "idle",
  channelId: null,
  channelName: "",
  muted: true,
  deafened: false,
  peers: [],
  audioBlocked: false,
  error: null,
  micLevel: 0,
};

type Selection = { input: string | null; output: string | null };

const NO_DEVICES: AudioDevices = { inputs: [], outputs: [] };

/** Microphone problems are the common failure, so they get their own text. */
function describeError(error: unknown): MessageKey {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "voice.error.mic";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "voice.error.noMic";
  return "voice.error.connect";
}

export function useVoice(serverUrl: string) {
  const [state, setState] = useState<VoiceState>(IDLE);
  const [devices, setDevices] = useState<AudioDevices>(NO_DEVICES);
  const [selection, setSelection] = useState<Selection>({ input: null, output: null });
  const [volumes, setVolumes] = useState<Record<string, number>>({});

  const roomRef = useRef<Room | null>(null);
  const channelRef = useRef<Channel | null>(null);
  const nodeRef = useRef<string | null>(null);
  const mutedRef = useRef(true);
  const deafenedRef = useRef(false);
  const mutedBeforeDeafenRef = useRef(false);
  const mountedRef = useRef(true);
  const inputRef = useRef<string | null>(null);
  const outputRef = useRef<string | null>(null);
  const volumesRef = useRef<Record<string, number>>({});
  const stopMeterRef = useRef<(() => void) | null>(null);

  const refreshDevices = useCallback(async () => {
    const next = await listAudioDevices();
    if (mountedRef.current) setDevices(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopMeterRef.current?.();
      stopMeterRef.current = null;
      roomRef.current?.disconnect().catch(() => undefined);
      roomRef.current = null;
      channelRef.current = null;
    };
  }, []);

  // Device labels only become readable after the first capture, so the list is
  // re-read whenever the system reports a change (headset plugged in, etc.).
  useEffect(() => {
    void refreshDevices();
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!media?.addEventListener) return;
    media.addEventListener("devicechange", refreshDevices);
    return () => media.removeEventListener("devicechange", refreshDevices);
  }, [refreshDevices]);

  const clearMeter = useCallback(() => {
    stopMeterRef.current?.();
    stopMeterRef.current = null;
    if (mountedRef.current) setState((current) => ({ ...current, micLevel: 0 }));
  }, []);

  const teardown = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    channelRef.current = null;
    clearMeter();
    if (room) {
      try {
        await room.disconnect();
      } catch {
        // The room may already be gone; nothing to clean up.
      }
    }
  }, [clearMeter]);

  const leave = useCallback(async () => {
    await teardown();
    mutedRef.current = true;
    deafenedRef.current = false;
    volumesRef.current = {};
    setVolumes({});
    if (mountedRef.current) setState(IDLE);
  }, [teardown]);

  const join = useCallback(
    async (channel: Channel) => {
      if (channelRef.current?.id === channel.id && roomRef.current) return;
      await teardown();

      // The selected input is baked into the room so the very first capture
      // already opens the right microphone; the output is switched afterwards.
      const input = inputRef.current;
      const room = new Room({
        adaptiveStream: false,
        dynacast: false,
        audioCaptureDefaults: input ? { deviceId: input } : undefined,
      });
      roomRef.current = room;
      channelRef.current = channel;

      const emit = () => {
        if (!mountedRef.current || roomRef.current !== room) return;
        setState((current) =>
          current.status === "idle"
            ? current
            : { ...current, peers: voicePeers(room), audioBlocked: !room.canPlaybackAudio },
        );
      };

      const startMeter = () => {
        stopMeterRef.current?.();
        stopMeterRef.current = null;
        if (!mountedRef.current || roomRef.current !== room) return;
        const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)
          ?.track?.mediaStreamTrack;
        if (!track) return;
        stopMeterRef.current = watchMicLevel(track, (level) => {
          if (mountedRef.current) {
            setState((current) =>
              current.status === "connected" ? { ...current, micLevel: level } : current,
            );
          }
        });
      };

      room.on(RoomEvent.ParticipantConnected, (participant) => {
        participant.setVolume(
          deafenedRef.current ? 0 : (volumesRef.current[participant.identity] ?? 1),
        );
        emit();
      });
      room.on(RoomEvent.ParticipantDisconnected, emit);
      room.on(RoomEvent.ActiveSpeakersChanged, emit);
      room.on(RoomEvent.TrackMuted, (publication) => {
        if (publication.isLocal && publication.source === Track.Source.Microphone) {
          clearMeter();
        }
        emit();
      });
      room.on(RoomEvent.TrackUnmuted, (publication) => {
        if (publication.isLocal && publication.source === Track.Source.Microphone) {
          startMeter();
        }
        emit();
      });
      room.on(RoomEvent.LocalTrackPublished, (publication) => {
        if (publication.source === Track.Source.Microphone) startMeter();
        emit();
      });
      room.on(RoomEvent.LocalTrackUnpublished, () => {
        clearMeter();
        emit();
      });
      room.on(RoomEvent.ParticipantMetadataChanged, emit);
      room.on(RoomEvent.AudioPlaybackStatusChanged, emit);
      room.on(RoomEvent.Disconnected, () => {
        // Anything but our own leave clears the room and tells the user.
        if (roomRef.current !== room) return;
        roomRef.current = null;
        channelRef.current = null;
        stopMeterRef.current?.();
        stopMeterRef.current = null;
        if (mountedRef.current) {
          setState({ ...IDLE, error: "voice.error.disconnected" });
        }
      });

      setState({
        ...IDLE,
        status: "connecting",
        channelId: channel.id,
        channelName: channel.name ?? "",
      });

      try {
        // The backend signs a token for a named node and refuses the request
        // otherwise; the name is stable for the lifetime of the session.
        if (!nodeRef.current) {
          nodeRef.current = voiceNodeName(await fetchServerInfo(serverUrl));
        }
        const { token, url } = await channel.joinCall(nodeRef.current ?? undefined);
        await room.connect(url, token);

        const output = outputRef.current;
        if (output) {
          await room.switchActiveDevice("audiooutput", output).catch(() => undefined);
        }

        // Listening without a microphone is a valid way to be in a call, so a
        // denied permission degrades to "muted" instead of ending the session.
        let muted = false;
        let micError: MessageKey | null = null;
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
        } catch (error) {
          muted = true;
          micError = describeError(error);
        }
        mutedRef.current = muted;

        if (!mountedRef.current) return;
        setState({
          status: "connected",
          channelId: channel.id,
          channelName: channel.name ?? "",
          muted,
          deafened: deafenedRef.current,
          peers: voicePeers(room),
          audioBlocked: !room.canPlaybackAudio,
          error: micError,
          micLevel: 0,
        });
        if (!muted) startMeter();
        await room.startAudio().catch(() => undefined);
      } catch (error) {
        await teardown();
        if (mountedRef.current) setState({ ...IDLE, error: describeError(error) });
      }
    },
    [clearMeter, serverUrl, teardown],
  );

  const toggleMute = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;

    const next = !mutedRef.current;
    mutedRef.current = next;
    setState((current) => ({ ...current, muted: next }));
    try {
      await room.localParticipant.setMicrophoneEnabled(!next);
    } catch (error) {
      mutedRef.current = !next;
      setState((current) => ({
        ...current,
        muted: !next,
        error: describeError(error),
      }));
    }
  }, []);

  const toggleDeafen = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;

    const next = !deafenedRef.current;
    deafenedRef.current = next;
    applyPeerVolumes(room, volumesRef.current, next);

    if (next) {
      // Deafen implies mute, and the previous microphone state is restored on
      // the way back out so the user does not have to think about it.
      mutedBeforeDeafenRef.current = mutedRef.current;
      mutedRef.current = true;
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
    } else {
      const restore = mutedBeforeDeafenRef.current;
      mutedRef.current = restore;
      await room.localParticipant.setMicrophoneEnabled(!restore).catch(() => undefined);
    }

    setState((current) => ({
      ...current,
      deafened: next,
      muted: mutedRef.current,
    }));
  }, []);

  const resumeAudio = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    await room.startAudio().catch(() => undefined);
    if (mountedRef.current) {
      setState((current) => ({ ...current, audioBlocked: !room.canPlaybackAudio }));
    }
  }, []);

  /**
   * "System default" is represented by `null`: the browser picks a device on
   * the next capture, which only happens on join, so a live call keeps the
   * concrete device it started with.
   */
  const selectInput = useCallback(async (deviceId: string | null) => {
    inputRef.current = deviceId;
    setSelection((current) => ({ ...current, input: deviceId }));
    const room = roomRef.current;
    if (!room || !deviceId) return;
    try {
      await room.switchActiveDevice("audioinput", deviceId);
    } catch {
      // A missing device falls back to the room's current one; the next join
      // picks the selection up anyway.
    }
  }, []);

  const selectOutput = useCallback(async (deviceId: string | null) => {
    outputRef.current = deviceId;
    setSelection((current) => ({ ...current, output: deviceId }));
    const room = roomRef.current;
    if (!room || !deviceId) return;
    try {
      await room.switchActiveDevice("audiooutput", deviceId);
    } catch {
      // Output switching needs a connected room with audio elements.
    }
  }, []);

  const setPeerVolume = useCallback((identity: string, volume: number) => {
    const next = { ...volumesRef.current, [identity]: volume };
    volumesRef.current = next;
    setVolumes(next);
    const room = roomRef.current;
    if (room && !deafenedRef.current) setRoomPeerVolume(room, identity, volume);
  }, []);

  return {
    status: state.status,
    channelId: state.channelId,
    channelName: state.channelName,
    muted: state.muted,
    deafened: state.deafened,
    peers: state.peers,
    audioBlocked: state.audioBlocked,
    error: state.error,
    micLevel: state.micLevel,
    inputs: devices.inputs as AudioDevice[],
    outputs: devices.outputs as AudioDevice[],
    inputId: selection.input,
    outputId: selection.output,
    volumes,
    joined: state.status === "connected",
    join,
    leave,
    toggleMute,
    toggleDeafen,
    resumeAudio,
    selectInput,
    selectOutput,
    setPeerVolume,
    refreshDevices,
  };
}
