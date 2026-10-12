import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';

import { safeRoute } from '@/lib/routes';
import { supabase } from '@/lib/supabase';

/**
 * Push notifications: Praktor on your computer tells you when a decision
 * needs you, work is ready to merge, or something failed. The phone's only
 * part is to register its push token (stored under RLS, readable by you and
 * your own computers) and to open the right screen when a notification is
 * tapped.
 */

// Shown even while the app is open — a decision arriving mid-session
// should still be noticed.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export type PushSupport = 'ok' | 'expo-go' | 'simulator';

/** Remote push needs a real device and a real build of the app. */
export function pushSupport(): PushSupport {
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return 'expo-go';
  if (!Device.isDevice) return 'simulator';
  return 'ok';
}

export type PushStatus = 'on' | 'off' | 'undetermined' | 'denied';

export async function pushStatus(): Promise<PushStatus> {
  const settings = await Notifications.getPermissionsAsync();
  const ios = settings.ios?.status;
  if (ios === Notifications.IosAuthorizationStatus.DENIED) return 'denied';
  if (ios === Notifications.IosAuthorizationStatus.NOT_DETERMINED) return 'undetermined';
  return settings.granted ? 'on' : 'off';
}

let currentToken: string | undefined;

async function expoToken(): Promise<string> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  const { data } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  return data;
}

export type EnableResult = { ok: true } | { ok: false; reason: 'unsupported' | 'denied' | 'failed' };

/** Asks iOS for permission (only ever from a tap, never on launch) and
 *  registers this phone with Praktor. */
export async function enablePush(): Promise<EnableResult> {
  if (pushSupport() !== 'ok') return { ok: false, reason: 'unsupported' };
  const permission = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  if (!permission.granted) return { ok: false, reason: 'denied' };
  try {
    const token = await expoToken();
    const { error } = await supabase.rpc('register_push_device', { p_token: token, p_name: Device.deviceName ?? 'iPhone' });
    if (error) return { ok: false, reason: 'failed' };
    currentToken = token;
    return { ok: true };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Re-registers silently when permission was already given — tokens can
 *  change, and a fresh sign-in needs this phone tied to the new account. */
export async function refreshPushRegistration(): Promise<void> {
  if (pushSupport() !== 'ok' || (await pushStatus()) !== 'on') return;
  try {
    const token = await expoToken();
    await supabase.rpc('register_push_device', { p_token: token, p_name: Device.deviceName ?? 'iPhone' });
    currentToken = token;
  } catch {
    // Best effort: the next launch tries again.
  }
}

/** Stops notifications to this phone — on sign-out, before the session ends. */
export async function disablePush(): Promise<void> {
  try {
    const token = currentToken ?? (pushSupport() === 'ok' ? await expoToken() : undefined);
    if (token) await supabase.rpc('unregister_push_device', { p_token: token });
  } catch {
    // Signing out must never be blocked by this.
  } finally {
    currentToken = undefined;
  }
}

/** Each tapped notification opens its screen once — not again on a later
 *  sign-in, when the "last response" is still the same old tap. */
const opened = new Set<string>();

/** Opens the screen a tapped notification points at — including the one
 *  that launched the app. */
export function useNotificationRouting(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      if (opened.has(id)) return;
      opened.add(id);
      const url = safeRoute(response.notification.request.content.data?.url);
      if (url) router.push(url as never);
    };
    Notifications.getLastNotificationResponseAsync().then(open);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [enabled]);
}
