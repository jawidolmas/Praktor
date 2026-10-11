import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { C } from '@/constants/theme';

/** System tab bar — Liquid Glass on iOS 26, minimizing as you scroll. */
export default function TabsLayout() {
  return (
    <NativeTabs tintColor={C.tint} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="objectives">
        <NativeTabs.Trigger.Label>Objectives</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'square.stack.3d.up', selected: 'square.stack.3d.up.fill' }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="computers">
        <NativeTabs.Trigger.Label>Computers</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="desktopcomputer" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
