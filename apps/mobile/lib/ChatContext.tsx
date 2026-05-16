// Hoists useChat() to app root so a chat session survives the chat
// screen unmounting (in-chat back button → home → re-enter chat). Same
// pattern as CallProvider for voice.

import { type ReactNode, createContext, useContext } from 'react';
import { type UseChatResult, useChat } from './gemini/useChat';

const ChatContext = createContext<UseChatResult | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

export function useChatContext(): UseChatResult {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useChatContext must be used inside <ChatProvider>');
  }
  return ctx;
}
