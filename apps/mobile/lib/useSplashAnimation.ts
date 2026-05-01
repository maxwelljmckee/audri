// Tracks whether the JS-side splash/launch animation has played in the
// current app session. Module-singleton (zustand), so subsequent re-mounts
// of <SplashAnimation /> short-circuit to null. Resets on cold start.

import { create } from 'zustand';

type State = {
  done: boolean;
  complete: () => void;
};

export const useSplashAnimation = create<State>((set) => ({
  done: false,
  complete: () => set({ done: true }),
}));
