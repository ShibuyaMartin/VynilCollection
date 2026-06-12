// Shared Supabase client. The URL and anon key are public by design — Row
// Level Security (supabase/schema.sql) is the security boundary.
//
// TODO(setup): replace the placeholders below with the real project values
// (Supabase Dashboard -> Settings -> API).

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";

export const SUPABASE_URL = "__SUPABASE_URL__";
export const SUPABASE_ANON_KEY = "__SUPABASE_ANON_KEY__";

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
