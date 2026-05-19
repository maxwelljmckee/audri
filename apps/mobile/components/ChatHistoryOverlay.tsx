// Chat History plugin shell. Hosts the scale-from-tile PluginOverlay around
// an independent React Navigation stack. Schema is generalized to support
// future text-chat (kind='text') alongside voice calls (kind='voice') —
// see chat_kind enum + call_transcripts.kind column. Today's data is all
// voice calls; the rendering already branches on `kind`.

import { PluginOverlay } from './PluginOverlay';
import { PluginNavigationContainer } from './PluginStack';
import { ChatHistoryStack } from './chatHistory/ChatHistoryNavigation';

export function ChatHistoryOverlay() {
  return (
    <PluginOverlay kind="chatHistory" title="Call History">
      <PluginNavigationContainer>
        <ChatHistoryStack />
      </PluginNavigationContainer>
    </PluginOverlay>
  );
}
