import React, { useCallback, useRef, useState } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from "react-native";

export type PluginScreenProps = { onClose: () => void };

type OverlayState = {
  Screen: React.ComponentType<PluginScreenProps>;
  origin: { x: number; y: number };
};

export function usePluginOverlay() {
  const animValue = useRef(new Animated.Value(0)).current;
  const [overlay, setOverlay] = useState<OverlayState | null>(null);

  const launch = useCallback(
    (
      Screen: React.ComponentType<PluginScreenProps>,
      ref: React.ComponentRef<typeof Pressable>
    ) => {
      ref.measure((_x, _y, w, h, pageX, pageY) => {
        setOverlay({ Screen, origin: { x: pageX + w / 2, y: pageY + h / 2 } });
        animValue.setValue(0);
        Animated.spring(animValue, {
          toValue: 1,
          useNativeDriver: true,
          tension: 100,
          friction: 12,
        }).start();
      });
    },
    [animValue]
  );

  const close = useCallback(() => {
    Animated.timing(animValue, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => setOverlay(null));
  }, [animValue]);

  return { launch, close, overlay, animValue };
}

type Props = {
  overlay: OverlayState | null;
  animValue: Animated.Value;
  onClose: () => void;
};

export function PluginOverlay({ overlay, animValue, onClose }: Props) {
  const { width, height } = useWindowDimensions();

  if (!overlay) return null;

  const { Screen, origin } = overlay;

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        {
          opacity: animValue,
          transform: [
            {
              translateX: animValue.interpolate({
                inputRange: [0, 1],
                outputRange: [origin.x - width / 2, 0],
              }),
            },
            {
              translateY: animValue.interpolate({
                inputRange: [0, 1],
                outputRange: [origin.y - height / 2, 0],
              }),
            },
            { scale: animValue },
          ],
        },
      ]}
    >
      <Screen onClose={onClose} />
    </Animated.View>
  );
}
