import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';

interface Props {
  reason?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}

// Shown when a call drops mid-conversation (network, server, app-backgrounded).
// Slice 2: debug-toggleable only. Real wiring lands in slice 3.
export function CallEndedDropped({ reason, onRetry, onDismiss }: Props) {
  return (
    <View className="flex-1 items-center justify-center gap-6 bg-azure-bg px-8">
      <View className="rounded-full bg-azure-surface p-5">
        <Ionicons name="cloud-offline-outline" size={48} color="#7aa3d4" />
      </View>
      <View className="items-center gap-1">
        <Text className="font-semibold text-azure-text text-xl">Call dropped</Text>
        <Text className="text-center text-azure-text-muted text-sm">
          {reason ?? 'Lost connection. Your conversation up to this point is saved.'}
        </Text>
      </View>
      <View className="flex-row gap-3">
        <Pressable
          onPress={onDismiss}
          className="rounded-xl bg-azure-surface px-6 py-3 active:opacity-70"
        >
          <Text className="font-medium text-azure-text text-base">Dismiss</Text>
        </Pressable>
        {onRetry && (
          <Pressable
            onPress={onRetry}
            className="rounded-xl bg-azure-accent px-6 py-3 active:opacity-80"
          >
            <Text className="font-medium text-base text-white">Try again</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
