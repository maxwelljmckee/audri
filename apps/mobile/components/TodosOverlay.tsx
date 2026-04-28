// Todos plugin shell. Same scale-from-tile pattern as the other overlays,
// hosting an independent React Navigation stack.

import { PluginNavigationContainer } from './PluginStack';
import { PluginOverlay } from './PluginOverlay';
import { TodosStack } from './todos/TodosNavigation';

export function TodosOverlay() {
  return (
    <PluginOverlay kind="todos" title="Todos">
      <PluginNavigationContainer>
        <TodosStack />
      </PluginNavigationContainer>
    </PluginOverlay>
  );
}
