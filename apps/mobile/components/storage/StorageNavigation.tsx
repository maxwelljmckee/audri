// Storage plugin stack. Screens:
//   - List: chronological Recently Added; uploads + url_sources merged
//   - Detail: per-item view (extracted text preview, attachments, actions)
//   - Add: routes to AddFile or AddUrl based on user pick
//   - AddFile: expo-document-picker → POST /uploads → PUT → /finalize
//   - AddUrl: paste form → POST /urls
//   - Attach: page picker → POST /uploads/:id/ingest or /urls/:id/ingest

import type { Ionicons } from '@expo/vector-icons';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AddFileScreen } from './screens/AddFileScreen';
import { AddPickerScreen } from './screens/AddPickerScreen';
import { AddUrlScreen } from './screens/AddUrlScreen';
import { AttachScreen } from './screens/AttachScreen';
import { DetailScreen } from './screens/DetailScreen';
import { ListScreen } from './screens/ListScreen';
import { pluginStackScreenOptions } from '../PluginStack';

export type StorageStackParamList = {
  List: undefined;
  Detail: { family: 'upload' | 'url_source'; itemId: string };
  AddPicker: undefined;
  AddFile: undefined;
  AddUrl: undefined;
  Attach: { family: 'upload' | 'url_source'; itemId: string };
};

const Stack = createNativeStackNavigator<StorageStackParamList>();

export function StorageStack() {
  return (
    <Stack.Navigator screenOptions={pluginStackScreenOptions} initialRouteName="List">
      <Stack.Screen name="List" component={ListScreen} />
      <Stack.Screen name="Detail" component={DetailScreen} />
      <Stack.Screen name="AddPicker" component={AddPickerScreen} />
      <Stack.Screen name="AddFile" component={AddFileScreen} />
      <Stack.Screen name="AddUrl" component={AddUrlScreen} />
      <Stack.Screen name="Attach" component={AttachScreen} />
    </Stack.Navigator>
  );
}

// Re-export icon names per kind so screens have one canonical mapping.
export const ITEM_KIND_ICON: Record<
  'pdf' | 'markdown' | 'plain' | 'docx' | 'web_article' | 'reddit_thread',
  React.ComponentProps<typeof Ionicons>['name']
> = {
  pdf: 'document-attach-outline',
  markdown: 'document-text-outline',
  plain: 'document-text-outline',
  docx: 'document-outline',
  web_article: 'link-outline',
  reddit_thread: 'chatbubbles-outline',
};
