// Account plugin shell. Repurposed from the original Profile plugin
// (2026-05-10): user profile content moved out (it lived under wiki
// `profile/*` pages and is now browsable via the Notes plugin), and
// this surface is now reserved for account-level concerns — billing,
// usage, subscription, sign-out, etc. Shipped as a stub today; real
// content lands as those features are scoped.

import { PluginOverlay } from './PluginOverlay';
import { PluginNavigationContainer } from './PluginStack';
import { AccountStack } from './account/AccountNavigation';

export function AccountOverlay() {
  return (
    <PluginOverlay kind="account" title="Account">
      <PluginNavigationContainer>
        <AccountStack />
      </PluginNavigationContainer>
    </PluginOverlay>
  );
}
