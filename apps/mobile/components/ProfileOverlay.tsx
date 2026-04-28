// Profile plugin shell. Same scale-from-tile pattern as Wiki + Research,
// hosting an independent React Navigation stack inside the overlay.

import { PluginNavigationContainer } from './PluginStack';
import { PluginOverlay } from './PluginOverlay';
import { ProfileStack } from './profile/ProfileNavigation';

export function ProfileOverlay() {
  return (
    <PluginOverlay kind="profile" title="Profile">
      <PluginNavigationContainer>
        <ProfileStack />
      </PluginNavigationContainer>
    </PluginOverlay>
  );
}
