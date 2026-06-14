// Social layer: likes and comments per record, plus following the
// collection's owner. Everything talks straight to Supabase under RLS.

import { supabase } from "/js/supabase-client.js";
import { getSession, getOwnProfile } from "/js/auth.js";

const els = {
  strip: document.getElementById("social-strip"),
  likeButton: document.getElementById("like-button"),
  likeCount: document.getElementById("like-count"),
  followButton: document.getElementById("follow-button"),
  ownerEditToggle: document.getElementById("owner-edit-toggle"),
  ownerEditPanel: document.getElementById("owner-edit-panel"),
  ownerReplaceForm: document.getElementById("owner-replace-form"),
  ownerReplaceInput: document.getElementById("owner-replace-input"),
  ownerReplaceButton: document.getElementById("owner-replace-button"),
  ownerResults: document.getElementById("owner-results"),
  ownerHide: document.getElementById("owner-hide"),
  ownerDelete: document.getElementById("owner-delete"),
  ownerStatus: document.getElementById("owner-status"),
  commentsPanel: document.getElementById("comments-panel"),
  commentsStatus: document.getElementById("comments-status"),
  commentsList: document.getElementById("comments-list"),
  commentForm: document.getElementById("comment-form"),
  commentInput: document.getElementById("comment-input"),
  commentsSignin: document.getElementById("comments-signin"),
};

let session = null;
let viewerId = null;
let currentRecord = null;
let currentRecordId = null;
let currentOwnerId = null;
let likedByMe = false;
let likeTotal = 0;
let fetchToken = 0;

export async function initSocial(owner) {
  if (!els.strip) {
    return;
  }

  session = await getSession();
  viewerId = session?.user?.id || null;

  await initFollow(owner);

  const loginHere = () =>
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);

  els.likeButton.addEventListener("click", async () => {
    if (!viewerId) {
      loginHere();
      return;
    }
    if (!currentRecordId) return;

    // Optimistic toggle.
    likedByMe = !likedByMe;
    likeTotal += likedByMe ? 1 : -1;
    paintLike();

    if (likedByMe) {
      await supabase.from("likes").insert({ record_id: currentRecordId, user_id: viewerId });
    } else {
      await supabase.from("likes").delete().eq("record_id", currentRecordId).eq("user_id", viewerId);
    }
  });

  els.commentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = els.commentInput.value.trim();
    if (!body || !currentRecordId || !viewerId) return;

    const profile = await getOwnProfile();
    if (!profile) {
      loginHere();
      return;
    }

    els.commentInput.disabled = true;
    const { error } = await supabase
      .from("comments")
      .insert({ record_id: currentRecordId, author_id: viewerId, body });
    els.commentInput.disabled = false;
    if (!error) {
      els.commentInput.value = "";
      await loadComments(currentRecordId, fetchToken);
    }
  });

  els.commentsList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete-comment]");
    if (!button) return;
    await supabase.from("comments").delete().eq("id", button.dataset.deleteComment);
    await loadComments(currentRecordId, fetchToken);
  });

  initOwnerTools();
}

// --- Owner tools: replace edition / delete --------------------------------

function initOwnerTools() {
  if (!els.ownerEditToggle) return;

  els.ownerEditToggle.addEventListener("click", () => {
    const opening = els.ownerEditPanel.hidden;
    els.ownerEditPanel.hidden = !opening;
    els.ownerStatus.textContent = "";
    // Open pre-loaded with this record's own search, so the right edition
    // is usually one tap away.
    if (opening && currentRecord) {
      els.ownerReplaceInput.value = `${currentRecord.artist} ${currentRecord.title}`.trim();
      searchEditions();
    }
  });

  els.ownerHide.addEventListener("click", async () => {
    if (!currentRecord) return;
    const next = !currentRecord.hidden;
    els.ownerHide.disabled = true;
    const { error } = await supabase.from("records").update({ hidden: next }).eq("id", currentRecordId);
    els.ownerHide.disabled = false;
    if (error) {
      els.ownerStatus.className = "social-note";
      els.ownerStatus.textContent = error.message || "Could not update.";
      return;
    }
    currentRecord.hidden = next;
    paintHideButton();
    els.ownerStatus.className = "social-note ok";
    els.ownerStatus.textContent = next
      ? "Hidden — only you can see this record now."
      : "Back to public.";
  });

  els.ownerDelete.addEventListener("click", async () => {
    if (!currentRecord) return;
    const name = `${currentRecord.artist} - ${currentRecord.title}`;
    if (!window.confirm(`Delete "${name}" from your collection? This also removes its likes and comments.`)) {
      return;
    }
    await ownerRequest("DELETE", { recordId: currentRecordId }, "Deleting…", "Deleted — reloading…");
  });

  els.ownerReplaceForm.addEventListener("submit", (event) => {
    event.preventDefault();
    searchEditions();
  });

  // Pick an edition from the results → replace in place.
  els.ownerResults.addEventListener("click", (event) => {
    const card = event.target.closest("[data-release-id]");
    if (!card) return;
    ownerRequest(
      "PATCH",
      { recordId: currentRecordId, releaseId: card.dataset.releaseId },
      "Fetching the new edition from Discogs…",
      "Edition replaced — reloading…"
    );
  });
}

function paintHideButton() {
  if (!els.ownerHide) return;
  const isHidden = Boolean(currentRecord && currentRecord.hidden);
  els.ownerHide.textContent = isHidden ? "Make public" : "Hide from public";
  els.ownerHide.classList.toggle("is-on", isHidden);
}

async function searchEditions() {
  const query = els.ownerReplaceInput.value.trim();
  if (!query) return;

  els.ownerStatus.textContent = "";
  els.ownerResults.innerHTML = '<p class="owner-results__status">Searching Discogs…</p>';

  let candidates = [];
  try {
    const response = await fetch(`/api/lookup?q=${encodeURIComponent(query)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Search failed");
    candidates = payload.candidates || [];
  } catch (error) {
    els.ownerResults.innerHTML = "";
    els.ownerStatus.textContent = error.message || "Search failed";
    return;
  }

  if (!candidates.length) {
    els.ownerResults.innerHTML = '<p class="owner-results__status">No editions found — refine the search.</p>';
    return;
  }

  els.ownerResults.replaceChildren(
    ...candidates.map((candidate) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "owner-result";
      card.dataset.releaseId = candidate.releaseId;

      const thumb = document.createElement("img");
      thumb.src = candidate.thumb || candidate.coverImage || "";
      thumb.alt = "";
      thumb.loading = "lazy";

      const meta = document.createElement("span");
      meta.className = "owner-result__meta";
      const title = document.createElement("strong");
      title.textContent = candidate.title;
      const sub = document.createElement("span");
      sub.textContent = [candidate.year, candidate.country, candidate.label, (candidate.formats || []).join(", ")]
        .filter(Boolean)
        .join(" · ");
      meta.append(title, sub);

      card.append(thumb, meta);
      if (currentRecord && String(candidate.releaseId) === String(currentRecord.discogsReleaseId)) {
        const tag = document.createElement("span");
        tag.className = "owner-result__current";
        tag.textContent = "Current";
        card.append(tag);
      }
      return card;
    })
  );
}

async function ownerRequest(method, body, busyText, doneText) {
  els.ownerDelete.disabled = true;
  els.ownerReplaceButton.disabled = true;
  els.ownerStatus.textContent = busyText;

  try {
    const response = await fetch("/api/records", {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Request failed");
    }
    els.ownerStatus.textContent = doneText;
    window.location.reload();
  } catch (error) {
    els.ownerStatus.textContent = error.message || "Request failed";
    els.ownerDelete.disabled = false;
    els.ownerReplaceButton.disabled = false;
  }
}

// Called whenever the active record changes. `record.id` is the row uuid.
export async function renderSocial(record, ownerId) {
  if (!els.strip) {
    return;
  }

  const token = ++fetchToken;

  if (!record) {
    currentRecord = null;
    currentRecordId = null;
    els.strip.hidden = true;
    els.commentsPanel.hidden = true;
    els.ownerEditPanel.hidden = true;
    return;
  }

  currentRecord = record;
  currentRecordId = record.id;
  currentOwnerId = ownerId;
  els.strip.hidden = false;
  els.commentsPanel.hidden = false;
  els.commentForm.hidden = !viewerId;
  els.commentsSignin.hidden = Boolean(viewerId);

  // Owner tools reset on every record change.
  els.ownerEditToggle.hidden = !(viewerId && viewerId === ownerId);
  els.ownerEditPanel.hidden = true;
  els.ownerStatus.textContent = "";
  els.ownerStatus.className = "social-note";
  els.ownerReplaceInput.value = "";
  els.ownerResults.replaceChildren();
  paintHideButton();

  // Reset while loading.
  likeTotal = 0;
  likedByMe = false;
  paintLike();
  els.commentsList.replaceChildren();
  els.commentsStatus.textContent = "…";

  const [likesResult] = await Promise.all([
    supabase.from("likes").select("user_id").eq("record_id", record.id),
    loadComments(record.id, token),
  ]);

  if (token !== fetchToken) {
    return; // A newer record took over.
  }

  const likes = likesResult.data || [];
  likeTotal = likes.length;
  likedByMe = Boolean(viewerId && likes.some((like) => like.user_id === viewerId));
  paintLike();
}

function paintLike() {
  els.likeCount.textContent = String(likeTotal);
  els.likeButton.classList.toggle("is-liked", likedByMe);
}

async function loadComments(recordId, token) {
  const { data } = await supabase
    .from("comments")
    .select("id, body, created_at, author_id, profiles(username, display_name)")
    .eq("record_id", recordId)
    .order("created_at", { ascending: true })
    .limit(100);

  if (token !== fetchToken) {
    return;
  }

  const comments = data || [];
  els.commentsStatus.textContent = comments.length
    ? `${comments.length} comment${comments.length === 1 ? "" : "s"}`
    : "No comments yet";

  els.commentsList.replaceChildren(
    ...comments.map((comment) => {
      const item = document.createElement("li");
      item.className = "comment";

      const author = document.createElement("a");
      author.className = "comment__author";
      author.textContent = comment.profiles?.display_name || comment.profiles?.username || "?";
      author.href = comment.profiles?.username ? `/u/${comment.profiles.username}` : "#";

      const body = document.createElement("p");
      body.className = "comment__body";
      body.textContent = comment.body;

      item.append(author, body);

      if (viewerId && (comment.author_id === viewerId || currentOwnerId === viewerId)) {
        const del = document.createElement("button");
        del.className = "comment__delete";
        del.type = "button";
        del.dataset.deleteComment = comment.id;
        del.setAttribute("aria-label", "Delete comment");
        del.textContent = "✕";
        item.append(del);
      }

      return item;
    })
  );
}

// --- Follow -----------------------------------------------------------------

async function initFollow(owner) {
  const button = els.followButton;
  if (!button || !owner || viewerId === owner.id) {
    return;
  }

  let following = false;
  if (viewerId) {
    const { data } = await supabase
      .from("follows")
      .select("follower_id")
      .eq("follower_id", viewerId)
      .eq("following_id", owner.id)
      .maybeSingle();
    following = Boolean(data);
  }

  const paint = () => {
    button.textContent = following ? "Following" : "Follow";
    button.classList.toggle("is-following", following);
  };
  paint();
  button.hidden = false;

  button.addEventListener("click", async () => {
    if (!viewerId) {
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }

    following = !following;
    paint();
    if (following) {
      await supabase.from("follows").insert({ follower_id: viewerId, following_id: owner.id });
    } else {
      await supabase.from("follows").delete().eq("follower_id", viewerId).eq("following_id", owner.id);
    }
  });
}
