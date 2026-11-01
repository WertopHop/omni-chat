import { useState } from "react";
import { ConnectionQuality } from "livekit-client";

import { useVoice } from "../hooks/useVoice";
import { useI18n, type Translate } from "../i18n";

type Props = {
  voice: ReturnType<typeof useVoice>;
};

/**
 * The media engine grades the link by round trip and loss; showing it turns a
 * "the call sounds bad" report into something the user can point at.
 */
function qualityLabel(t: Translate, quality: ConnectionQuality): string {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return t("voice.quality.excellent");
    case ConnectionQuality.Good:
      return t("voice.quality.good");
    case ConnectionQuality.Poor:
      return t("voice.quality.poor");
    default:
      return t("voice.quality.unknown");
  }
}

function qualityTone(quality: ConnectionQuality): string {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return "excellent";
    case ConnectionQuality.Good:
      return "good";
    case ConnectionQuality.Poor:
      return "poor";
    default:
      return "unknown";
  }
}

/**
 * Compact call strip in the channel sidebar: who is in the call, who is
 * talking, the microphone meter, a per-participant volume and the device
 * picker. Everything sits here because the call outlives the channel view.
 */
export function VoiceBar({ voice }: Props) {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (voice.status === "idle") return null;

  const connecting = voice.status === "connecting";
  const level = Math.min(100, Math.round(voice.micLevel * 250));

  return (
    <section className="voice-bar">
      <header className="voice-head">
        <span className={connecting ? "voice-dot" : "voice-dot on"} />
        <span className="voice-channel">{voice.channelName}</span>
        {connecting && <span className="voice-state">{t("voice.connecting")}</span>}
        {!connecting && (
          <span
            className={`voice-quality ${qualityTone(voice.quality)}`}
            title={t("voice.quality.title")}
          >
            {qualityLabel(t, voice.quality)}
          </span>
        )}
        <button
          className={settingsOpen ? "voice-btn settings on" : "voice-btn settings"}
          title={t("voice.settings")}
          aria-label={t("voice.settings")}
          aria-expanded={settingsOpen}
          onClick={() => {
            const next = !settingsOpen;
            setSettingsOpen(next);
            if (next) void voice.refreshDevices();
          }}
        >
          ⚙
        </button>
      </header>

      {settingsOpen && (
        <div className="voice-devices">
          <label>
            <span>{t("voice.device.input")}</span>
            <select
              value={voice.inputId ?? ""}
              disabled={voice.inputs.length === 0}
              onChange={(event) => void voice.selectInput(event.target.value || null)}
            >
              <option value="">{t("voice.device.default")}</option>
              {voice.inputs.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || t("voice.device.unknown", { index: index + 1 })}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("voice.device.output")}</span>
            <select
              value={voice.outputId ?? ""}
              disabled={voice.outputs.length === 0}
              onChange={(event) => void voice.selectOutput(event.target.value || null)}
            >
              <option value="">{t("voice.device.default")}</option>
              {voice.outputs.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || t("voice.device.unknown", { index: index + 1 })}
                </option>
              ))}
            </select>
          </label>
          <p className="voice-device-note">{t("voice.mic.test")}</p>
        </div>
      )}

      {!connecting && (
        <>
          <div
            className="voice-mic"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={level}
            title={t("voice.mic.level")}
          >
            <span className="voice-mic-fill" style={{ width: `${level}%` }} />
          </div>

          <ul className="voice-peers">
            {voice.peers.map((peer) => (
              <li
                key={peer.identity}
                className={peer.speaking ? "voice-peer speaking" : "voice-peer"}
                title={peer.name}
              >
                <span className="voice-avatar">{peer.name.slice(0, 2)}</span>
                <span className="voice-peer-name">
                  {peer.self ? `${peer.name} (${t("voice.you")})` : peer.name}
                </span>
                {peer.muted && (
                  <span className="voice-peer-muted" aria-label={t("voice.muted")}>
                    ·
                  </span>
                )}
                {!peer.self && (
                  <input
                    className="voice-peer-volume"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={voice.volumes[peer.identity] ?? 1}
                    title={t("voice.volume")}
                    aria-label={`${t("voice.volume")}: ${peer.name}`}
                    onChange={(event) =>
                      voice.setPeerVolume(peer.identity, Number(event.target.value))
                    }
                  />
                )}
              </li>
            ))}
            {voice.peers.length === 1 && (
              <li className="voice-peer empty">{t("voice.alone")}</li>
            )}
          </ul>
        </>
      )}

      {voice.error && <div className="error">{t(voice.error)}</div>}

      {voice.audioBlocked && (
        <button className="ghost small" onClick={voice.resumeAudio}>
          {t("voice.resume")}
        </button>
      )}

      <div className="voice-actions">
        <button
          className={voice.muted ? "voice-btn off" : "voice-btn"}
          aria-pressed={voice.muted}
          title={voice.muted ? t("voice.unmute") : t("voice.mute")}
          aria-label={voice.muted ? t("voice.unmute") : t("voice.mute")}
          disabled={connecting}
          onClick={voice.toggleMute}
        >
          {voice.muted ? "🔇" : "🎤"}
        </button>
        <button
          className={voice.deafened ? "voice-btn off" : "voice-btn"}
          aria-pressed={voice.deafened}
          title={voice.deafened ? t("voice.undeafen") : t("voice.deafen")}
          aria-label={voice.deafened ? t("voice.undeafen") : t("voice.deafen")}
          disabled={connecting}
          onClick={voice.toggleDeafen}
        >
          🎧
        </button>
        <button
          className="voice-btn leave"
          title={t("voice.leave")}
          onClick={() => void voice.leave()}
        >
          {t("voice.leave")}
        </button>
      </div>
    </section>
  );
}
