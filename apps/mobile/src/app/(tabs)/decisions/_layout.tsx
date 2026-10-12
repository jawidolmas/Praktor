import { Stack } from 'expo-router';

export default function DecisionsLayout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTransparent: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
      }}>
      <Stack.Screen name="index" options={{ title: 'Decisions' }} />
      <Stack.Screen name="[id]" options={{ headerLargeTitle: false, headerBackTitle: 'Decisions' }} />
    </Stack>
  );
}
