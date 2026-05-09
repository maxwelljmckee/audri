// Call-screen orb. Wraps the project-owned shader-driven Orb component
// from `components/animations/orb-shader-animation-with-react-native-skia/`
// and feeds it call state so the visual reflects what's happening.
//
// State → visual mapping:
//   - idle / connecting  → blue hue, intensity 0 (the shader's built-in
//                          slow breath gives some life at zero intensity)
//   - user speaking      → cyan hue, intensity = compressed mic amplitude
//   - agent speaking     → indigo hue, intensity = constant moderate value
//                          (no agent-output amplitude is tracked yet)
//
// Hue is passed as a plain number; transitions snap on speaker change.
// The shader's `hueByIntensity` is disabled so it doesn't override our
// state-driven hue with its own oscillation.

import React, { useEffect } from 'react';
import { ActivityIndicator } from 'react-native';
import { useSharedValue, withTiming } from 'react-native-reanimated';
import { useCallStore } from '../lib/useCallStore';
import ShaderOrb from './animations/orb-shader-animation-with-react-native-skia';

const ORB_SIZE = 240;

// Per-state hue rotations applied to the shader's purple-leaning base.
// Note: these are YIQ-space rotations applied to a 3-color palette, so
// they don't map 1:1 to HSL hue — small gaps (≤30°) read as nearly
// identical. Push gaps to 60°+ for clear separation. Tune as needed.
const ORB_HUE_IDLE = 200; // blue
const ORB_HUE_USER = 100; // cyan-leaning (−100° from idle)
const ORB_HUE_AGENT = 300; // indigo-leaning (+100° from idle)

// Tuning knobs for the audio-reactive intensity:
//   - INPUT_GAIN: scales the sqrt-curved amplitude. Higher = quieter
//     speech triggers more response.
//   - MAX_INTENSITY: ceiling so loud speech doesn't blow out the visual.
//     Below 1.0 keeps the wiggle bounded; the orb has plenty of motion
//     even at modest intensity.
//   - AGENT_INTENSITY: constant used while the agent speaks. Just below
//     MAX_INTENSITY so it reads as clearly active without jittering.
const INPUT_GAIN = 1.2;
const MAX_INTENSITY = 0.2;
const AGENT_INTENSITY = 0.15;

export function Orb() {
  const speaker = useCallStore((s) => s.currentSpeaker);
  const amplitude = useCallStore((s) => s.amplitude);

  const intensity = useSharedValue(0);

  useEffect(() => {
    if (speaker === 'user') {
      // sqrt curve boosts low-amplitude response (quiet speech becomes
      // visible), gain scales further, hard cap limits the visual ceiling.
      const boosted = Math.min(Math.sqrt(amplitude) * INPUT_GAIN, MAX_INTENSITY);
      intensity.value = withTiming(boosted, { duration: 80 });
    } else if (speaker === 'agent') {
      intensity.value = withTiming(AGENT_INTENSITY, { duration: 200 });
    } else {
      intensity.value = withTiming(0, { duration: 400 });
    }
  }, [speaker, amplitude, intensity]);

  const hue =
    speaker === 'user' ? ORB_HUE_USER : speaker === 'agent' ? ORB_HUE_AGENT : ORB_HUE_IDLE;

  return (
    <React.Suspense fallback={<ActivityIndicator color="#e8f1ff" />}>
      <ShaderOrb
        hue={hue}
        intensity={intensity}
        width={ORB_SIZE}
        height={ORB_SIZE}
        hueByIntensity={false}
      />
    </React.Suspense>
  );
}
