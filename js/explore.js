// Landing page: every collection on Deadwax, with a strip of cover art.

import { supabase, coverPublicUrl } from "/js/supabase-client.js";
import { getOwnProfile } from "/js/auth.js";

const container = document.getElementById("collections");
const authLink = document.getElementById("auth-link");

init().catch(() => {
  container.innerHTML = '<p class="status">Could not load collections. Try reloading.</p>';
});

async function init() {
  // Personalize the header link when signed in.
  getOwnProfile().then((profile) => {
    if (profile) {
      authLink.textContent = `@${profile.username}`;
      authLink.href = `/u/${profile.username}`;
    }
  });

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, username, display_name, bio")
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    throw error;
  }

  if (!profiles?.length) {
    container.innerHTML = '<p class="status">No collections yet — be the first.</p>';
    return;
  }

  // Covers and counts per collection (aggregates are disabled on Supabase,
  // so counts come from head requests; the profile list is small).
  const [coverRows, counts] = await Promise.all([
    Promise.all(
      profiles.map((profile) =>
        supabase
          .from("records")
          .select("cover_path")
          .eq("owner_id", profile.id)
          .not("cover_path", "is", null)
          .order("position", { ascending: false })
          .limit(4)
          .then((result) => result.data || [])
      )
    ),
    Promise.all(
      profiles.map((profile) =>
        supabase
          .from("records")
          .select("id", { count: "exact", head: true })
          .eq("owner_id", profile.id)
          .then((result) => result.count || 0)
      )
    ),
  ]);

  container.replaceChildren(
    ...profiles.map((profile, index) => {
      const card = document.createElement("a");
      card.className = "collection-card";
      card.href = `/u/${profile.username}`;

      const covers = document.createElement("div");
      covers.className = "collection-card__covers";
      const paths = coverRows[index];
      for (let i = 0; i < 4; i += 1) {
        if (paths[i]) {
          const img = document.createElement("img");
          img.src = coverPublicUrl(paths[i].cover_path);
          img.alt = "";
          img.loading = "lazy";
          covers.append(img);
        } else {
          const ph = document.createElement("div");
          ph.className = "ph";
          covers.append(ph);
        }
      }

      const name = document.createElement("h2");
      name.textContent = profile.display_name || profile.username;

      const meta = document.createElement("p");
      meta.className = "meta";
      const count = counts[index];
      meta.textContent = `@${profile.username} · ${count} record${count === 1 ? "" : "s"}`;

      card.append(covers, name, meta);

      if (profile.bio) {
        const bio = document.createElement("p");
        bio.className = "bio";
        bio.textContent = profile.bio;
        card.append(bio);
      }

      return card;
    })
  );
}
