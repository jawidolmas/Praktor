import { router, Stack } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable } from 'react-native';

import { C } from '@/constants/theme';

function NewChatButton() {
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/chat/[thread]', params: { thread: 'new' } })}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="New chat">
      <SymbolView name="square.and.pencil" size={22} tintColor={C.tint} />
    </Pressable>
  );
}

export default function ChatLayout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTransparent: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
      }}>
      <Stack.Screen name="index" options={{ title: 'Praktor', headerRight: () => <NewChatButton /> }} />
    </Stack>
  );
}
