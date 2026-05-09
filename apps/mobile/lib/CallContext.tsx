// Hoists `useCall()` to app root so the call session — audio session,
// Gemini Live WebSocket, transcript, AppState handler — survives screen
// unmount/remount. Without this, navigating away from the call screen
// (via the in-call back button) would tear down the live session.
//
// The hook still owns its lifecycle; we just lift WHERE it's called.
// `useCallContext()` lets any screen (call, onboarding, home FAB) read
// from the same session instance.

import { type ReactNode, createContext, useContext } from 'react';
import { type UseCallResult, useCall } from './gemini/useCall';

const CallContext = createContext<UseCallResult | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const call = useCall();
  return <CallContext.Provider value={call}>{children}</CallContext.Provider>;
}

export function useCallContext(): UseCallResult {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error('useCallContext must be used inside <CallProvider>');
  }
  return ctx;
}
