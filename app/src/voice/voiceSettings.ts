/**
 * Per-device settings of the Aria voice call (docs/design/ARIA-VOICE.md, ARIA-HOST.md). Pure: no React / native imports,
 * so deviceSettings.ts and the node tests can both load it.
 * Everything else about the call (speaking style, voice, LLM) is per user and lives on the OmniChat server (voiceApi.ts).
 */

export type VoiceCodec = 'pcm16' | 'opus';

export interface VoiceSettings {
  /** audio codec asked for in hello; opus needs WebCodecs and falls back to pcm16 where it is missing */
  codec: VoiceCodec;
  /** send the mic only while the call-bar button / the space key is held */
  pushToTalk: boolean;
  /** start calls without saving them (the switch before the call starts defaults to this) */
  privateDefault: boolean;
}

export const VOICE_DEFAULTS: VoiceSettings = {
  codec: 'pcm16',
  pushToTalk: false,
  privateDefault: false,
};

/** A stored or partial value as a valid VoiceSettings. Old stored fields (url, token, ...) are ignored. */
export function normalizeVoice(raw: unknown): VoiceSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    codec: r.codec === 'opus' || r.codec === 'pcm16' ? r.codec : VOICE_DEFAULTS.codec,
    pushToTalk: r.pushToTalk === true,
    privateDefault: r.privateDefault === true,
  };
}
