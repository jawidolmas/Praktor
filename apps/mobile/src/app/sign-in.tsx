import * as AppleAuthentication from 'expo-apple-authentication';
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { C, Radius, Space, Type } from '@/constants/theme';
import { signInWithApple } from '@/lib/auth';

export default function SignIn() {
  const scheme = useColorScheme();
  const [available, setAvailable] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    AppleAuthentication.isAvailableAsync().then(setAvailable);
  }, []);

  async function onSignIn() {
    setBusy(true);
    setError(undefined);
    const result = await signInWithApple();
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
          <SymbolView name="square.stack.3d.up.fill" size={44} tintColor="white" weight="semibold" />
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

        {available === false ? (
          <Text style={styles.error}>Sign in with Apple isn’t available on this device.</Text>
        ) : busy || available === undefined ? (
          <View style={styles.buttonSlot}>
            <ActivityIndicator />
          </View>
        ) : (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={
              scheme === 'dark'
                ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
            }
            cornerRadius={Radius.pill}
            style={styles.buttonSlot}
            onPress={onSignIn}
          />
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
    width: 88,
    height: 88,
    borderRadius: 22,
    borderCurve: 'continuous',
    backgroundColor: C.tint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Space.l,
  },
  title: { ...Type.largeTitle, color: C.label },
  subtitle: { ...Type.body, color: C.secondaryLabel, textAlign: 'center' },
  bottom: { paddingBottom: Space.xl, gap: Space.l },
  buttonSlot: { height: 54, width: '100%', alignItems: 'center', justifyContent: 'center' },
  error: { ...Type.footnote, color: C.red, textAlign: 'center' },
  promise: { flexDirection: 'row', gap: 6, justifyContent: 'center', paddingHorizontal: Space.l },
  promiseText: { ...Type.footnote, color: C.secondaryLabel, textAlign: 'center', flexShrink: 1 },
});
