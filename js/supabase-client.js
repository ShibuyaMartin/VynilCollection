// Shared Supabase client. The URL and anon key are public by design — Row
// Level Security (supabase/schema.sql) is the security boundary.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";

export const SUPABASE_URL = "https://uypdmqqudkqssbggmmxv.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_3fcyIqc4C4YgGhcxVMhUOQ_YefFAIj0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    detectSessionInUrl: true,
    // Implicit flow: PKCE breaks when the magic link opens in a different
    // browser context (e.g. the mail app's in-app browser).
    flowType: "implicit",
    persistSession: true,
    autoRefreshToken: true,
  },
});

export function coverPublicUrl(coverPath) {
  if (!coverPath) {
    return "";
  }
  return `${SUPABASE_URL}/storage/v1/object/public/covers/${coverPath}`;
}

export function avatarPublicUrl(avatarPath) {
  if (!avatarPath) {
    return "";
  }
  return `${SUPABASE_URL}/storage/v1/object/public/avatars/${avatarPath}`;
}
