// Magic-link sign-in plus first-login profile setup (username + display name).

import { supabase } from "/js/supabase-client.js";
import { getSession, getOwnProfile } from "/js/auth.js";

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/;
const RESERVED_USERNAMES = new Set(["add", "api", "login", "u", "data", "covers", "vinilos", "index", "assets", "explore"]);

const heading = document.getElementById("login-heading");
const emailForm = document.getElementById("email-form");
const emailInput = document.getElementById("email-input");
const emailSubmit = document.getElementById("email-submit");
const sentBox = document.getElementById("sent-box");
const sentCopy = document.getElementById("sent-copy");
const profileForm = document.getElementById("profile-form");
const usernameInput = document.getElementById("username-input");
const displayNameInput = document.getElementById("display-name-input");
const profileSubmit = document.getElementById("profile-submit");
const errorBox = document.getElementById("login-error");

const nextPath = sanitizeNext(new URLSearchParams(window.location.search).get("next"));

init();

async function init() {
  // detectSessionInUrl consumes the magic-link tokens automatically; give the
  // client a tick to do so before checking.
  await supabase.auth.getSession();
  const session = await getSession();
  if (session) {
    await handleSignedIn();
  }

  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN") {
      handleSignedIn();
    }
  });
}

async function handleSignedIn() {
  errorBox.textContent = "";
  const profile = await getOwnProfile();
  if (profile) {
    window.location.replace(nextPath || `/u/${profile.username}`);
    return;
  }

  heading.textContent = "Create your profile";
  emailForm.hidden = true;
  sentBox.hidden = true;
  profileForm.hidden = false;
  usernameInput.focus();
}

emailForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.textContent = "";
  emailSubmit.disabled = true;

  const email = emailInput.value.trim();
  const redirectTo = `${window.location.origin}/login${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""}`;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo },
  });

  emailSubmit.disabled = false;
  if (error) {
    errorBox.textContent = error.message;
    return;
  }

  emailForm.hidden = true;
  sentBox.hidden = false;
  sentCopy.textContent = `Magic link sent to ${email}. Open it on this device to sign in.`;
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.textContent = "";

  const username = usernameInput.value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username) || RESERVED_USERNAMES.has(username)) {
    errorBox.textContent = "Usernames are 3-30 chars: lowercase letters, numbers and dashes.";
    return;
  }

  profileSubmit.disabled = true;
  const session = await getSession();
  const { error } = await supabase.from("profiles").insert({
    id: session.user.id,
    username,
    display_name: displayNameInput.value.trim() || username,
  });
  profileSubmit.disabled = false;

  if (error) {
    errorBox.textContent = error.code === "23505" ? "That username is taken — try another." : error.message;
    return;
  }

  window.location.replace(nextPath || `/u/${username}`);
});

function sanitizeNext(value) {
  // Same-origin paths only; anything else is dropped.
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "";
  }
  return value;
}
