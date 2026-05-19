// Storage plugin shell. Scale-from-tile PluginOverlay around its own
// React Navigation stack. Hosts the uploads + URL sources mixed feed.

import { PluginOverlay } from './PluginOverlay';
import { PluginNavigationContainer } from './PluginStack';
import { StorageStack } from './storage/StorageNavigation';

export function StorageOverlay() {
  return (
    <PluginOverlay kind="storage" title="Uploads">
      <PluginNavigationContainer>
        <StorageStack />
      </PluginNavigationContainer>
    </PluginOverlay>
  );
}
