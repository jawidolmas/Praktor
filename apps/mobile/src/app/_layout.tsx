import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { AuthProvider, useSession } from '@/lib/auth';

SplashScreen.preventAutoHideAsync();

function RootStack() {
  const session = useSession();

  // Hold the splash screen until the Keychain session has been read, so a
  // signed-in person never sees the sign-in screen flash past.
  useEffect(() => {
    if (session !== undefined) SplashScreen.hideAsync();
  }, [session]);
  if (session === undefined) return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="add-computer"
          options={{ presentation: 'formSheet', sheetGrabberVisible: true, sheetAllowedDetents: [0.92] }}
        />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AuthProvider>
        <RootStack />
      </AuthProvider>
    </ThemeProvider>
  );
}
