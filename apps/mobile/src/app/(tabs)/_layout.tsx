import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { C } from '@/constants/theme';
import { fetchDecisions, fetchReadyToMerge, useLive } from '@/lib/relay';

/** System tab bar — Liquid Glass on iOS 26, minimizing as you scroll. */
export default function TabsLayout() {
  const decisions = useLive('decisions-badge', ['decisions'], fetchDecisions);
  const merges = useLive('merge-badge', ['objectives'], fetchReadyToMerge);
  // Everything waiting on a person: open decisions and finished work to merge.
  const waiting = (decisions.data ?? []).filter((d) => d.status === 'open').length + (merges.data?.length ?? 0);

  return (
    <NativeTabs tintColor={C.tint} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="objectives">
        <NativeTabs.Trigger.Label>Objectives</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'square.stack.3d.up', selected: 'square.stack.3d.up.fill' }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="decisions">
        <NativeTabs.Trigger.Label>Decisions</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'bubble.left.and.exclamationmark.bubble.right', selected: 'bubble.left.and.exclamationmark.bubble.right.fill' }} />
        {waiting > 0 ? <NativeTabs.Trigger.Badge>{String(waiting)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="computers">
        <NativeTabs.Trigger.Label>Computers</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="desktopcomputer" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
