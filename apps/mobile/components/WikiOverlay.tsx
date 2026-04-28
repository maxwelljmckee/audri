// Wiki plugin shell. Hosts the scale-from-tile PluginOverlay around an
// independent React Navigation stack. Each screen lives in `wiki/` — this
// file is just the wiring.

import { PluginNavigationContainer } from './PluginStack';
import { PluginOverlay } from './PluginOverlay';
import { WikiStack } from './wiki/WikiNavigation';

export function WikiOverlay() {
  return (
    <PluginOverlay kind="wiki" title="Wiki">
      <PluginNavigationContainer>
        <WikiStack />
      </PluginNavigationContainer>
    </PluginOverlay>
  );
}
