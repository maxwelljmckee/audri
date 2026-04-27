// Mic capture → 16kHz PCM16 mono frames + RMS amplitude.
//
// Mic-gate API: when gated=true, frames are dropped at the send layer (not the
// hardware layer) so the mic stays open continuously. This matters for barge-
// in: the orb still sees amplitude during model playback, and we can flip
// gated=false the moment we detect user speech.

import { AudioManager, AudioRecorder } from 'react-native-audio-api';
import { float32ToPcm16, pcm16ToBase64, rmsAmplitude } from './audio-utils';

export const MIC_SAMPLE_RATE = 16000;
const MIC_BUFFER_LENGTH = 1600; // 100ms at 16kHz

export interface AudioInputHandle {
  start: () => Promise<void>;
  stop: () => void;
  setGated: (gated: boolean) => void;
  onFrame: (cb: (base64Pcm: string) => void) => () => void;
  onAmplitude: (cb: (amp: number) => void) => () => void;
  onError: (cb: (err: Error) => void) => () => void;
}

export function createAudioInput(): AudioInputHandle {
  let recorder: AudioRecorder | null = null;
  let gated = false;

  const frameSubs = new Set<(b64: string) => void>();
  const ampSubs = new Set<(a: number) => void>();
  const errSubs = new Set<(e: Error) => void>();

  function emitFrame(b64: string) {
    for (const cb of frameSubs) cb(b64);
  }
  function emitAmp(a: number) {
    for (const cb of ampSubs) cb(a);
  }
  function emitErr(e: Error) {
    for (const cb of errSubs) cb(e);
  }

  return {
    async start() {
      const permission = await AudioManager.requestRecordingPermissions();
      if (permission !== 'Granted') {
        throw new Error(`mic permission denied: ${permission}`);
      }

      const rec = new AudioRecorder();
      recorder = rec;

      rec.onError((err) => emitErr(new Error(JSON.stringify(err))));

      rec.onAudioReady(
        { sampleRate: MIC_SAMPLE_RATE, bufferLength: MIC_BUFFER_LENGTH, channelCount: 1 },
        ({ buffer }) => {
          const float32 = buffer.getChannelData(0);
          // Always compute amplitude (orb feedback even when gated).
          emitAmp(rmsAmplitude(float32));
          if (gated) return;
          const pcm16 = float32ToPcm16(float32);
          emitFrame(pcm16ToBase64(pcm16));
        },
      );

      rec.start();
    },

    stop() {
      try {
        recorder?.stop();
      } catch {}
      recorder = null;
    },

    setGated(g: boolean) {
      gated = g;
    },

    onFrame(cb) {
      frameSubs.add(cb);
      return () => frameSubs.delete(cb);
    },
    onAmplitude(cb) {
      ampSubs.add(cb);
      return () => ampSubs.delete(cb);
    },
    onError(cb) {
      errSubs.add(cb);
      return () => errSubs.delete(cb);
    },
  };
}
