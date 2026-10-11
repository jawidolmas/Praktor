import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { EmptyState, PrimaryButton } from '@/components/ui';
import { C, Radius, Space, Type } from '@/constants/theme';
import { claimErrorMessage, parseClaimCode } from '@/lib/claim';
import { claimHost } from '@/lib/relay';
import { supabase } from '@/lib/supabase';

type Phase =
  | { kind: 'scanning'; hint?: string }
  | { kind: 'claiming' }
  | { kind: 'added'; name: string }
  | { kind: 'failed'; message: string };

export default function AddComputer() {
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>({ kind: 'scanning' });
  // The camera reports the same code many times a second; handle one.
  const handling = useRef(false);

  async function onScanned({ data }: BarcodeScanningResult) {
    if (handling.current || phase.kind !== 'scanning') return;
    const code = parseClaimCode(data);
    if (!code) {
      setPhase({ kind: 'scanning', hint: 'That’s not a Praktor code. Scan the one your computer shows.' });
      return;
    }
    handling.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPhase({ kind: 'claiming' });
    try {
      const hostId = await claimHost(code);
      const { data: host } = await supabase.from('hosts').select('name').eq('id', hostId).single();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPhase({ kind: 'added', name: host?.name ?? 'Your computer' });
    } catch (err) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setPhase({ kind: 'failed', message: claimErrorMessage(err instanceof Error ? err.message : '') });
    }
  }

  function scanAgain() {
    handling.current = false;
    setPhase({ kind: 'scanning' });
  }

  let body: React.ReactNode;
  if (!permission) {
    body = <ActivityIndicator style={{ marginTop: 80 }} />;
  } else if (!permission.granted) {
    body = (
      <EmptyState
        symbol="camera.viewfinder"
        title="Scan your computer’s code"
        message={
          permission.canAskAgain
            ? 'Praktor uses the camera only to read the pairing code on your computer’s screen.'
            : 'Camera access is off for Praktor. Turn it on in Settings to scan the pairing code.'
        }
        action={
          permission.canAskAgain ? (
            <PrimaryButton title="Allow Camera" symbol="camera.fill" onPress={requestPermission} />
          ) : (
            <PrimaryButton title="Open Settings" symbol="gear" onPress={() => Linking.openSettings()} />
          )
        }
      />
    );
  } else if (phase.kind === 'added') {
    body = (
      <EmptyState
        symbol="checkmark.circle.fill"
        title={`“${phase.name}” is connected`}
        message="Its objectives start appearing within a minute, and stay live from then on."
        action={<PrimaryButton title="Done" onPress={() => router.back()} />}
      />
    );
  } else if (phase.kind === 'failed') {
    body = (
      <EmptyState
        symbol="exclamationmark.triangle.fill"
        title="Couldn’t add it"
        message={phase.message}
        action={<PrimaryButton title="Scan Again" symbol="qrcode.viewfinder" onPress={scanAgain} />}
      />
    );
  } else {
    body = (
      <View style={styles.scan}>
        <Text style={styles.instructions}>On your computer, run</Text>
        <View style={styles.command}>
          <Text style={styles.commandText} selectable>
            exec-agent cloud connect
          </Text>
        </View>
        <Text style={styles.instructions}>then point your camera at the code it shows.</Text>

        <View style={styles.viewfinder}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={phase.kind === 'scanning' ? onScanned : undefined}
          />
          {phase.kind === 'claiming' ? (
            <View style={styles.claiming}>
              <ActivityIndicator color="white" />
              <Text style={styles.claimingText}>Connecting…</Text>
            </View>
          ) : null}
        </View>

        <Text style={[styles.hint, phase.kind === 'scanning' && phase.hint ? { color: C.orange } : null]}>
          {phase.kind === 'scanning' && phase.hint
            ? phase.hint
            : 'Only scan a code shown on your own computer. Whoever’s computer it is will be able to see your Praktor activity.'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle} accessibilityRole="header">
          Add a Computer
        </Text>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={styles.close}>
          <SymbolView name="xmark" size={14} tintColor={C.secondaryLabel} weight="bold" />
        </Pressable>
      </View>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingTop: Space.xl, paddingBottom: Space.s },
  headerTitle: { ...Type.headline, color: C.label },
  close: {
    position: 'absolute',
    right: Space.l,
    top: Space.l + 2,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scan: { paddingHorizontal: Space.xl, paddingTop: Space.l, alignItems: 'center', gap: Space.s },
  instructions: { ...Type.subheadline, color: C.secondaryLabel, textAlign: 'center' },
  command: { backgroundColor: C.card, borderRadius: 10, borderCurve: 'continuous', paddingHorizontal: Space.m, paddingVertical: 6 },
  commandText: { ...Type.mono, color: C.label },
  viewfinder: {
    marginTop: Space.l,
    width: '100%',
    aspectRatio: 1,
    maxWidth: 340,
    borderRadius: Radius.card + 6,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: 'black',
  },
  claiming: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.s,
  },
  claimingText: { ...Type.headline, color: 'white' },
  hint: { ...Type.footnote, color: C.secondaryLabel, textAlign: 'center', marginTop: Space.m, paddingHorizontal: Space.s },
});
