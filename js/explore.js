// Home: every collection on Deadwax as an animated card — a full-bleed cover
// that shrinks to reveal the owner, their roles/city and a Follow button.

import { supabase, coverPublicUrl, avatarPublicUrl } from "/js/supabase-client.js";
import { getSession, getOwnProfile } from "/js/auth.js";

const container = document.getElementById("collections");
const authLink = document.getElementById("auth-link");
const ROLE_LABELS = { collector: "Collector", dj: "DJ", store: "Store" };

let viewerId = null;
let following = new Set();

init().catch((error) => {
  console.error(error);
  container.innerHTML = '<p class="status">Could not load collections. Try reloading.</p>';
});

async function init() {
  const session = await getSession();
  viewerId = session?.user?.id || null;

  getOwnProfile().then((profile) => {
    if (profile) {
      authLink.textContent = `@${profile.username}`;
      authLink.href = "/settings";
    }
  });

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, username, display_name, bio, roles, city, avatar_path")
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;

  if (!profiles?.length) {
    container.innerHTML = '<p class="status">No collections yet — be the first.</p>';
    return;
  }

  const [coverRows, counts, followerCounts] = await Promise.all([
    Promise.all(
      profiles.map((profile) =>
        supabase
          .from("records")
          .select("cover_path")
          .eq("owner_id", profile.id)
          .not("cover_path", "is", null)
          .order("position", { ascending: false })
          .limit(4)
          .then((result) => (result.data || []).map((row) => row.cover_path))
      )
    ),
    Promise.all(
      profiles.map((profile) =>
        supabase.from("records").select("id", { count: "exact", head: true }).eq("owner_id", profile.id)
          .then((result) => result.count || 0)
      )
    ),
    Promise.all(
      profiles.map((profile) =>
        supabase.from("follows").select("follower_id", { count: "exact", head: true }).eq("following_id", profile.id)
          .then((result) => result.count || 0)
      )
    ),
  ]);

  if (viewerId) {
    const { data } = await supabase.from("follows").select("following_id").eq("follower_id", viewerId);
    following = new Set((data || []).map((row) => row.following_id));
  }

  container.replaceChildren(
    ...profiles.map((profile, index) =>
      buildCard(profile, coverRows[index], counts[index], followerCounts[index])
    )
  );
}

function buildCard(profile, covers, count, followers) {
  const card = document.createElement("a");
  card.className = "card";
  card.href = `/u/${profile.username}`;

  // Hero image: the most recent cover, or the avatar, or a placeholder.
  const cover = document.createElement("div");
  cover.className = "card__cover";
  const heroSrc = covers[0] ? coverPublicUrl(covers[0]) : avatarPublicUrl(profile.avatar_path);
  if (heroSrc) {
    const img = document.createElement("img");
    img.src = heroSrc;
    img.alt = "";
    img.loading = "lazy";
    cover.append(img);
  } else {
    cover.classList.add("card__cover--empty");
    cover.textContent = (profile.display_name || profile.username || "?").charAt(0).toUpperCase();
  }

  // Name shown over the cover while collapsed.
  const band = document.createElement("div");
  band.className = "card__band";
  const bandName = document.createElement("span");
  bandName.textContent = profile.display_name || profile.username;
  band.append(bandName);

  // Body revealed on hover/focus.
  const body = document.createElement("div");
  body.className = "card__body";

  const name = document.createElement("h2");
  name.textContent = profile.display_name || profile.username;

  const meta = document.createElement("p");
  meta.className = "card__meta";
  meta.textContent =
    `@${profile.username} · ${count} record${count === 1 ? "" : "s"}` +
    (followers ? ` · ${followers} follower${followers === 1 ? "" : "s"}` : "");

  body.append(name, meta);

  const chips = [...(profile.roles || []).map((r) => ROLE_LABELS[r] || r)];
  if (profile.city) chips.push(profile.city);
  if (chips.length) {
    const tags = document.createElement("div");
    tags.className = "card__tags";
    for (const label of chips) {
      const tag = document.createElement("span");
      tag.className = "card__tag";
      tag.textContent = label;
      tags.append(tag);
    }
    body.append(tags);
  }

  const foot = document.createElement("div");
  foot.className = "card__foot";
  const open = document.createElement("span");
  open.className = "card__open";
  open.textContent = "View collection →";
  foot.append(open);

  // Follow button — not shown on your own card.
  if (profile.id !== viewerId) {
    foot.append(buildFollowButton(profile));
  }
  body.append(foot);

  card.append(cover, band, body);
  return card;
}

function buildFollowButton(profile) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card__follow";

  let isFollowing = following.has(profile.id);
  const paint = () => {
    button.textContent = isFollowing ? "Following" : "Follow";
    button.classList.toggle("is-following", isFollowing);
  };
  paint();

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!viewerId) {
      window.location.assign("/login?next=/explore");
      return;
    }
    isFollowing = !isFollowing;
    paint();
    if (isFollowing) {
      await supabase.from("follows").insert({ follower_id: viewerId, following_id: profile.id });
    } else {
      await supabase.from("follows").delete().eq("follower_id", viewerId).eq("following_id", profile.id);
    }
  });

  return button;
}
