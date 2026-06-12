// Session helpers shared by the gallery, the add flow and the login page.

import { supabase } from "/js/supabase-client.js";

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

// Redirects to the login page (preserving the destination) when there is no
// session. Returns the session otherwise.
export async function requireSession(next) {
  const session = await getSession();
  if (!session) {
    window.location.replace(`/login?next=${encodeURIComponent(next || window.location.pathname)}`);
    return null;
  }
  return session;
}

export async function getOwnProfile() {
  const session = await getSession();
  if (!session) {
    return null;
  }

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .maybeSingle();
  return data || null;
}

export async function signOut() {
  await supabase.auth.signOut();
}
