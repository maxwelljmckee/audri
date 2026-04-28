// Research plugin shell. Hosts the scale-from-tile PluginOverlay around an
// independent React Navigation stack. Each screen lives in `research/` —
// this file is just the wiring.

import { PluginNavigationContainer } from './PluginStack';
import { PluginOverlay } from './PluginOverlay';
import { ResearchStack } from './research/ResearchNavigation';

export function ResearchOverlay() {
  return (
    <PluginOverlay kind="research" title="Research">
      <PluginNavigationContainer>
        <ResearchStack />
      </PluginNavigationContainer>
    </PluginOverlay>
  );
}
