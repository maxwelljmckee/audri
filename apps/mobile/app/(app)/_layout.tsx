import { Redirect, Stack } from 'expo-router';
import { useSession } from '../../lib/useSession';

// Main app stack — bounces signed-out users to sign-in. Transparent
// contentStyle so the root LavaLamp shows through during route transitions
// (otherwise the nested native-stack would paint a white card on iOS,
// which would defeat the new transparent-screen pattern).
export default function AppLayout() {
  const session = useSession();
  if (session.status === 'signed-out') return <Redirect href="/(auth)/sign-in" />;
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: 'transparent' },
      }}
    />
  );
}
