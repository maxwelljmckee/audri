// Choice screen — file upload vs URL submission. Lands when the user
// taps "Add to Storage" from the List.

import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PluginBackRow } from '../../PluginStack';
import type { StorageStackParamList } from '../StorageNavigation';

export function AddPickerScreen({
  navigation,
}: NativeStackScreenProps<StorageStackParamList, 'AddPicker'>) {
  return (
    <View style={styles.flex}>
      <PluginBackRow label="Storage" onPress={() => navigation.goBack()} />
      <View style={styles.body}>
        <Text style={styles.title}>What do you want to add?</Text>
        <Text style={styles.hint}>
          Uploads and URLs sit in Storage until you attach them to a Note.
        </Text>

        <Pressable style={styles.option} onPress={() => navigation.replace('AddFile')}>
          <View style={styles.optionIcon}>
            <Ionicons name="document-attach-outline" size={24} color="#7aa3d4" />
          </View>
          <View style={styles.optionMain}>
            <Text style={styles.optionTitle}>Upload a file</Text>
            <Text style={styles.optionSubtitle}>PDF, markdown, plain text, or DOCX</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
        </Pressable>

        <Pressable style={styles.option} onPress={() => navigation.replace('AddUrl')}>
          <View style={styles.optionIcon}>
            <Ionicons name="link-outline" size={24} color="#7aa3d4" />
          </View>
          <View style={styles.optionMain}>
            <Text style={styles.optionTitle}>Add a URL</Text>
            <Text style={styles.optionSubtitle}>Web article, PDF link, or Reddit thread</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { padding: 16, gap: 12 },
  title: { color: '#e8f1ff', fontSize: 18, fontWeight: '600' },
  hint: { color: '#7aa3d4', fontSize: 13, lineHeight: 18, marginBottom: 8 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#11203a',
    padding: 14,
    borderRadius: 8,
  },
  optionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#0a1628',
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionMain: { flex: 1, gap: 2 },
  optionTitle: { color: '#e8f1ff', fontSize: 15, fontWeight: '600' },
  optionSubtitle: { color: '#7aa3d4', fontSize: 12 },
});
