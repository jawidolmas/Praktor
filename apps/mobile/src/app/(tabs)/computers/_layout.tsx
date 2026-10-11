import { Stack } from 'expo-router';

export default function ComputersLayout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerTransparent: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
      }}>
      <Stack.Screen name="index" options={{ title: 'Computers' }} />
    </Stack>
  );
}
