import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

import { keychainStorage } from '@/lib/keychain-storage';

/**
 * The relay. Only the project URL and its *publishable* key live in the app:
 * both are public by design, and every row the app can see is decided by
 * Row Level Security on the server, never by anything in this bundle.
 */
export const SUPABASE_URL = 'https://xzochoyigfnrtjxchmkr.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_3_VDFKUI2jcXcU3WP_fsnQ_Se9fro3p';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: keychainStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Refresh tokens only while the app is in the foreground: iOS suspends
// timers in the background anyway, and resuming cleanly on return beats a
// refresh that fires half-asleep.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
