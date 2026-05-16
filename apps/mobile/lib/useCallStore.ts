import { create } from 'zustand';

export type CallStatus = 'idle' | 'connecting' | 'connected' | 'ending' | 'dropped';
export type Speaker = 'user' | 'agent' | null;
export type CallModality = 'voice' | 'text';

interface CallStore {
  status: CallStatus;
  currentSpeaker: Speaker;
  amplitude: number; // 0..1, normalized; orb uses this directly
  // Wall-clock timestamp set when /calls/start succeeds. Used by the
  // call screen to compute elapsed time correctly across mount/unmount
  // (in-call back button → home → rejoin) — local state would reset to
  // 0 on every remount.
  startedAt: number | null;
  // Voice (default) or text-chat. Set by the screen that initiates the
  // session; the home FAB reads this to know which screen to re-route
  // to when the user taps "rejoin".
  modality: CallModality;
  // Incognito sessions skip /end + snapshot persistence. Same agent
  // experience, no server-side residue.
  incognito: boolean;

  startCall: () => void;
  markConnected: () => void;
  endCall: () => void; // hang-up flow: ending → idle
  markDropped: () => void; // network drop / forced disconnect
  reset: () => void; // back to idle from any state

  setSpeaker: (s: Speaker) => void;
  setAmplitude: (a: number) => void;
  setStartedAt: (t: number | null) => void;
  setModality: (m: CallModality) => void;
  setIncognito: (i: boolean) => void;
}

// Held at module scope so navigating away from /call doesn't tear down state.
export const useCallStore = create<CallStore>((set) => ({
  status: 'idle',
  currentSpeaker: null,
  amplitude: 0,
  startedAt: null,
  modality: 'voice',
  incognito: false,

  startCall: () => set({ status: 'connecting', currentSpeaker: null, amplitude: 0 }),
  markConnected: () => set({ status: 'connected' }),
  endCall: () => set({ status: 'ending' }),
  markDropped: () => set({ status: 'dropped' }),
  reset: () =>
    set({
      status: 'idle',
      currentSpeaker: null,
      amplitude: 0,
      startedAt: null,
      modality: 'voice',
      incognito: false,
    }),

  setSpeaker: (currentSpeaker) => set({ currentSpeaker }),
  setAmplitude: (amplitude) => set({ amplitude }),
  setStartedAt: (startedAt) => set({ startedAt }),
  setModality: (modality) => set({ modality }),
  setIncognito: (incognito) => set({ incognito }),
}));
