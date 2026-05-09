import { create } from 'zustand';

export type CallStatus = 'idle' | 'connecting' | 'connected' | 'ending' | 'dropped';
export type Speaker = 'user' | 'agent' | null;

interface CallStore {
  status: CallStatus;
  currentSpeaker: Speaker;
  amplitude: number; // 0..1, normalized; orb uses this directly
  // Wall-clock timestamp set when /calls/start succeeds. Used by the
  // call screen to compute elapsed time correctly across mount/unmount
  // (in-call back button → home → rejoin) — local state would reset to
  // 0 on every remount.
  startedAt: number | null;

  startCall: () => void;
  markConnected: () => void;
  endCall: () => void; // hang-up flow: ending → idle
  markDropped: () => void; // network drop / forced disconnect
  reset: () => void; // back to idle from any state

  setSpeaker: (s: Speaker) => void;
  setAmplitude: (a: number) => void;
  setStartedAt: (t: number | null) => void;
}

// Held at module scope so navigating away from /call doesn't tear down state.
export const useCallStore = create<CallStore>((set) => ({
  status: 'idle',
  currentSpeaker: null,
  amplitude: 0,
  startedAt: null,

  startCall: () => set({ status: 'connecting', currentSpeaker: null, amplitude: 0 }),
  markConnected: () => set({ status: 'connected' }),
  endCall: () => set({ status: 'ending' }),
  markDropped: () => set({ status: 'dropped' }),
  reset: () => set({ status: 'idle', currentSpeaker: null, amplitude: 0, startedAt: null }),

  setSpeaker: (currentSpeaker) => set({ currentSpeaker }),
  setAmplitude: (amplitude) => set({ amplitude }),
  setStartedAt: (startedAt) => set({ startedAt }),
}));
