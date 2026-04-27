// PCM playback queue for Gemini Live model audio.
//
// Critical invariant (per memory + sandbox lessons):
//   `isPlaying` flips to false only when the LAST queued buffer's onEnded
//   fires — NOT on the server's turnComplete signal. The server frequently
//   marks a turn complete while audio is still in our queue; if we treated
//   turnComplete as "Audri is done", we'd open the mic-gate too early and
//   the speaker output would echo back into Gemini and start a new turn.

import { AudioContext, type AudioBufferQueueSourceNode } from 'react-native-audio-api';
import { base64ToInt16Array } from './audio-utils';

export const PLAYBACK_SAMPLE_RATE = 24000;

export interface AudioOutputHandle {
  enqueue: (base64Pcm: string) => void;
  // Mark that the server has signaled turnComplete. We DON'T flip isPlaying
  // here — we wait for the queue to drain via onEnded.
  markTurnComplete: () => void;
  // Barge-in: clear all pending buffers + cancel in-flight playback.
  flush: () => void;
  destroy: () => void;
  onPlaybackStart: (cb: () => void) => () => void;
  onPlaybackEnd: (cb: () => void) => () => void;
  isPlaying: () => boolean;
}

export function createAudioOutput(): AudioOutputHandle {
  let ctx: AudioContext | null = null;
  let source: AudioBufferQueueSourceNode | null = null;
  let pending = 0;
  let turnEnding = false;
  let playing = false;

  const startSubs = new Set<() => void>();
  const endSubs = new Set<() => void>();

  function getCtx(): AudioContext {
    if (!ctx) ctx = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    return ctx;
  }

  function setPlaying(p: boolean) {
    if (p === playing) return;
    playing = p;
    for (const cb of p ? startSubs : endSubs) cb();
  }

  function finalizeIfDrained() {
    if (!turnEnding) return;
    if (pending > 0) return;
    if (source) {
      try {
        source.stop();
      } catch {}
      source = null;
    }
    turnEnding = false;
    setPlaying(false);
  }

  return {
    enqueue(base64Pcm: string) {
      const c = getCtx();
      const pcm = base64ToInt16Array(base64Pcm);
      const float32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        float32[i] = (pcm[i] ?? 0) / 32768;
      }
      const buffer = c.createBuffer(1, pcm.length, PLAYBACK_SAMPLE_RATE);
      buffer.copyToChannel(float32, 0);

      if (!source) {
        const src = c.createBufferQueueSource();
        src.connect(c.destination);
        // Per-buffer onEnded — see file header.
        src.onEnded = () => {
          if (source !== src) return;
          pending = Math.max(0, pending - 1);
          finalizeIfDrained();
        };
        src.start();
        source = src;
        setPlaying(true);
      }
      source.enqueueBuffer(buffer);
      pending++;
    },

    markTurnComplete() {
      turnEnding = true;
      finalizeIfDrained();
    },

    flush() {
      if (source) {
        try {
          source.clearBuffers();
          source.stop();
        } catch {}
        source = null;
      }
      pending = 0;
      turnEnding = false;
      setPlaying(false);
    },

    destroy() {
      this.flush();
      try {
        ctx?.close();
      } catch {}
      ctx = null;
    },

    onPlaybackStart(cb) {
      startSubs.add(cb);
      return () => startSubs.delete(cb);
    },
    onPlaybackEnd(cb) {
      endSubs.add(cb);
      return () => endSubs.delete(cb);
    },
    isPlaying() {
      return playing;
    },
  };
}
