// Account plugin's stack navigation. Stubbed today (single screen) — will
// grow as billing / usage / subscription features land. Profile-content
// browsing is intentionally NOT here; the user's `profile/*` wiki pages
// live in the Notes plugin (single-source-of-truth rule).

import { Ionicons } from '@expo/vector-icons';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../../lib/supabase';
import { pluginStackScreenOptions } from '../PluginStack';

export type AccountStackParamList = {
  Home: undefined;
};

const Stack = createNativeStackNavigator<AccountStackParamList>();

export function AccountStack() {
  return (
    <Stack.Navigator screenOptions={pluginStackScreenOptions} initialRouteName="Home">
      <Stack.Screen name="Home" component={HomeScreen} />
    </Stack.Navigator>
  );
}

function HomeScreen() {
  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <View style={styles.flex}>
      <View style={styles.body}>
        <Section label="Coming soon">
          <StubRow icon="card-outline" title="Billing" subtitle="Manage your subscription" />
          <StubRow icon="speedometer-outline" title="Usage" subtitle="Calls, ingestion, research" />
          <StubRow icon="settings-outline" title="Preferences" subtitle="Voice, defaults, theme" />
        </Section>

        <Section label="Account">
          <Pressable style={styles.row} onPress={signOut}>
            <View style={styles.rowIcon}>
              <Ionicons name="log-out-outline" size={20} color="#f87171" />
            </View>
            <View style={styles.rowMain}>
              <Text style={[styles.rowTitle, { color: '#f87171' }]}>Sign out</Text>
            </View>
          </Pressable>
        </Section>
      </View>
    </View>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function StubRow({
  icon,
  title,
  subtitle,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  subtitle: string;
}) {
  return (
    <View style={[styles.row, styles.rowDisabled]}>
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={20} color="#3f5a83" />
      </View>
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, styles.rowTitleDisabled]}>{title}</Text>
        <Text style={styles.rowSubtitle}>{subtitle}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { paddingTop: 12 },

  section: { paddingTop: 16, paddingHorizontal: 16, gap: 8 },
  sectionLabel: {
    color: '#7aa3d4',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sectionBody: {
    backgroundColor: '#0e1c30',
    borderRadius: 10,
    overflow: 'hidden',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
  },
  rowDisabled: { opacity: 0.6 },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#11203a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMain: { flex: 1, gap: 2 },
  rowTitle: { color: '#e8f1ff', fontSize: 15, fontWeight: '500' },
  rowTitleDisabled: { color: '#7aa3d4' },
  rowSubtitle: { color: '#7aa3d4', fontSize: 12 },
});
