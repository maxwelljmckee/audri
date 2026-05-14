// Automations plugin shell. Scale-from-tile PluginOverlay around its own
// React Navigation stack. Screens live in `automations/` — this is wiring.

import { AutomationsStack } from './automations/AutomationsNavigation';
import { PluginOverlay } from './PluginOverlay';
import { PluginNavigationContainer } from './PluginStack';

export function AutomationsOverlay() {
  return (
    <PluginOverlay kind="automations" title="Automations">
      <PluginNavigationContainer>
        <AutomationsStack />
      </PluginNavigationContainer>
    </PluginOverlay>
  );
}
