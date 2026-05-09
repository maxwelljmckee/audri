// Agents plugin shell. Hosts the scale-from-tile PluginOverlay around an
// independent React Navigation stack. Each screen lives in `agents/` —
// this file is just the wiring.
//
// v0.2 substrate: surfaces the per-persona open-items queue (questions +
// info-shares the agent is "thinking about"). Read-only display + snooze /
// dismiss interactions per DP-4 resolution. Manual question seeding is V1+.

import { PluginOverlay } from './PluginOverlay';
import { PluginNavigationContainer } from './PluginStack';
import { AgentsStack } from './agents/AgentsNavigation';

export function AgentsOverlay() {
  return (
    <PluginOverlay kind="agents" title="Agents">
      <PluginNavigationContainer>
        <AgentsStack />
      </PluginNavigationContainer>
    </PluginOverlay>
  );
}
