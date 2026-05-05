import { Redirect, Stack } from 'expo-router';
import { useSession } from '../../lib/useSession';

// Auth flow stack — bounces signed-in users out to (app). Transparent
// contentStyle so the root LavaLamp shows through (otherwise this nested
// native-stack paints a white card over the backdrop on iOS).
export default function AuthLayout() {
  const session = useSession();
  if (session.status === 'signed-in') return <Redirect href="/(app)" />;
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: 'transparent' },
      }}
    />
  );
}
