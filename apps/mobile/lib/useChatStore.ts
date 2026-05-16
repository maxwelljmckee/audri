import { create } from 'zustand';

// Minimal store for text-chat sessions. Voice has a much richer store
// (speaker / amplitude / startedAt for the Orb + elapsed timer); chat
// only needs a status flag so the home FAB can detect an active session
// and route rejoin to /chat. Everything else lives inside useChat /
// transcript state.
export type ChatStatus = 'idle' | 'connecting' | 'connected' | 'ending' | 'dropped';

interface ChatStore {
  status: ChatStatus;
  startChat: () => void;
  markConnected: () => void;
  endChat: () => void; // hang-up flow: ending → idle
  markDropped: () => void;
  reset: () => void;
}

export const useChatStore = create<ChatStore>((set) => ({
  status: 'idle',
  startChat: () => set({ status: 'connecting' }),
  markConnected: () => set({ status: 'connected' }),
  endChat: () => set({ status: 'ending' }),
  markDropped: () => set({ status: 'dropped' }),
  reset: () => set({ status: 'idle' }),
}));
