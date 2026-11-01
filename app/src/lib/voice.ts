/**
 * Voice helpers on top of the LiveKit room.
 *
 * The chat backend hands out a short-lived token and the node URL from
 * `POST /channels/<id>/join_call`; tracks, subscriptions and speaking
 * detection all live in the room, so the UI works with the small view model
 * below instead of SDK objects.
 */
import type { Room } from "livekit-client";

/** One row in the voice bar. */
export type VoicePeer = {
  identity: string;
  name: string;
  muted: boolean;
  speaking: boolean;
  self: boolean;
};

export type AudioDevice = {
  deviceId: string;
  label: string;
};

export type AudioDevices = {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
};

const EMPTY_DEVICES: AudioDevices = { inputs: [], outputs: [] };

export function voicePeers(room: Room): VoicePeer[] {
  const self = room.localParticipant;
  const everyone = [self, ...room.remoteParticipants.values()];
  return everyone.map((participant) => ({
    identity: participant.identity,
    name: participant.name || participant.identity,
    muted: !participant.isMicrophoneEnabled,
    speaking: participant.isSpeaking,
    self: participant === self,
  }));
}

/**
 * `enumerateDevices` lists the same hardware twice (a "default" alias plus the
 * real entry) and repeats unnamed entries until the user grants access, so the
 * list is collapsed on the label.
 */
function collapse(devices: MediaDeviceInfo[]): AudioDevice[] {
  const seen = new Set<string>();
  const result: AudioDevice[] = [];
  for (const device of devices) {
    if (!device.deviceId) continue;
    const key = device.label || device.deviceId;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ deviceId: device.deviceId, label: device.label });
  }
  return result;
}

export async function listAudioDevices(): Promise<AudioDevices> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return EMPTY_DEVICES;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: collapse(devices.filter((device) => device.kind === "audioinput")),
      outputs: collapse(devices.filter((device) => device.kind === "audiooutput")),
    };
  } catch {
    return EMPTY_DEVICES;
  }
}

/**
 * Deafen is a listener-side setting, so it is applied to the remote audio
 * tracks instead of the microphone: 0 keeps the sound off while the call stays
 * connected. Per-peer volume is stored per identity and re-applied here, so
 * undeafen and late joiners both get the right level.
 */
export function applyPeerVolumes(
  room: Room,
  volumes: Record<string, number>,
  deafened: boolean,
): void {
  room.remoteParticipants.forEach((participant) => {
    participant.setVolume(deafened ? 0 : (volumes[participant.identity] ?? 1));
  });
}

export function setPeerVolume(room: Room, identity: string, volume: number): void {
  room.remoteParticipants.get(identity)?.setVolume(volume);
}

/**
 * Peak level of a microphone track, sampled on the UI thread.
 *
 * It is built from the track the room already publishes, so the "mic test"
 * neither opens a second capture nor sends audio anywhere: the level simply
 * shows what the other side would receive.
 */
export function watchMicLevel(
  track: MediaStreamTrack,
  onLevel: (level: number) => void,
): () => void {
  const AudioContextCtor =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext);
  if (!AudioContextCtor) return () => undefined;

  const context = new AudioContextCtor();
  const source = context.createMediaStreamSource(new MediaStream([track]));
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);
  let frame = 0;
  let last = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    frame = requestAnimationFrame(tick);
    const now = performance.now();
    // Roughly 15 updates per second: enough to follow speech, few enough to
    // keep React from re-rendering the bar on every frame.
    if (now - last < 66) return;
    last = now;

    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const value of data) {
      const amplitude = Math.abs(value - 128) / 128;
      if (amplitude > peak) peak = amplitude;
    }
    onLevel(peak);
  };

  void context.resume().catch(() => undefined);
  frame = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    source.disconnect();
    void context.close().catch(() => undefined);
  };
}
