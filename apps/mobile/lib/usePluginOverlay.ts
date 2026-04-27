// Single-slot plugin overlay state. Whichever plugin tile was last tapped
// determines the overlay's content + the origin rect it animates from.

import { create } from 'zustand';

export type PluginKind = 'wiki' | 'todos' | 'research' | 'profile';

export interface OriginRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PluginOverlayState {
  open: PluginKind | null;
  origin: OriginRect | null;
  show: (kind: PluginKind, origin: OriginRect) => void;
  hide: () => void;
}

export const usePluginOverlay = create<PluginOverlayState>((set) => ({
  open: null,
  origin: null,
  show: (open, origin) => set({ open, origin }),
  hide: () => set({ open: null }),
}));
