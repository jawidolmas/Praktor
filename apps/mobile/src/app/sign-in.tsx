import * as AppleAuthentication from 'expo-apple-authentication';
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GoogleButton } from '@/components/google-button';
import { PraktorMark } from '@/components/praktor-mark';
import { C, Radius, Space, Type } from '@/constants/theme';
import { signInWithApple, signInWithGoogle, type SignInResult } from '@/lib/auth';

export default function SignIn() {
  const scheme = useColorScheme();
  const [available, setAvailable] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    AppleAuthentication.isAvailableAsync().then(setAvailable);
  }, []);

  async function run(provider: () => Promise<SignInResult>) {
    setBusy(true);
    setError(undefined);
    const result = await provider();
    setBusy(false);
    if (result.ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (!result.cancelled) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(result.message);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.hero}>
        <View style={styles.mark}>
          <PraktorMark size={88} />
        </View>
        <Text style={styles.title} accessibilityRole="header">
          Praktor
        </Text>
        <Text style={styles.subtitle}>Your agents, wherever you are.</Text>
      </View>

      <View style={styles.bottom}>
        {error ? (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        {busy || available === undefined ? (
          <View style={styles.buttonSlot}>
            <ActivityIndicator />
          </View>
        ) : (
          <View style={styles.buttons}>
            {/* Shown only where the native module exists — not in Expo Go. */}
            {available ? (
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                buttonStyle={
                  scheme === 'dark'
                    ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                    : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                }
                cornerRadius={Radius.pill}
                style={styles.buttonSlot}
                onPress={() => run(signInWithApple)}
              />
            ) : null}
            <GoogleButton onPress={() => run(signInWithGoogle)} />
          </View>
        )}

        <View style={styles.promise}>
          <SymbolView name="lock.fill" size={13} tintColor={C.secondaryLabel} />
          <Text style={styles.promiseText}>
            Your code never leaves your computer. Only status, costs and file names sync to this app.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background, paddingHorizontal: Space.xxl },
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.s },
  mark: {
    marginBottom: Space.l,
    shadowColor: '#066ce7',
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
  },
  title: { ...Type.largeTitle, color: C.label },
  subtitle: { ...Type.body, color: C.secondaryLabel, textAlign: 'center' },
  bottom: { paddingBottom: Space.xl, gap: Space.l },
  buttons: { gap: Space.m },
  buttonSlot: { height: 54, width: '100%', alignItems: 'center', justifyContent: 'center' },
  error: { ...Type.footnote, color: C.red, textAlign: 'center' },
  promise: { flexDirection: 'row', gap: 6, justifyContent: 'center', paddingHorizontal: Space.l },
  promiseText: { ...Type.footnote, color: C.secondaryLabel, textAlign: 'center', flexShrink: 1 },
});
