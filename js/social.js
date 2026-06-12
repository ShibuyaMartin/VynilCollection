// Social layer for a record: likes, comments and the "is this for sale?"
// ping. Likes and comments talk straight to Supabase under RLS; the ping
// goes through /api/ping (rate-limited, owner email stays server-side).

import { supabase } from "/js/supabase-client.js";
import { getSession, getOwnProfile } from "/js/auth.js";

const els = {
  strip: document.getElementById("social-strip"),
  likeButton: document.getElementById("like-button"),
  likeCount: document.getElementById("like-count"),
  pingButton: document.getElementById("ping-button"),
  pingForm: document.getElementById("ping-form"),
  pingMessage: document.getElementById("ping-message"),
  pingShareEmail: document.getElementById("ping-share-email"),
  pingSend: document.getElementById("ping-send"),
  pingStatus: document.getElementById("ping-status"),
  commentsPanel: document.getElementById("comments-panel"),
  commentsStatus: document.getElementById("comments-status"),
  commentsList: document.getElementById("comments-list"),
  commentForm: document.getElementById("comment-form"),
  commentInput: document.getElementById("comment-input"),
  commentsSignin: document.getElementById("comments-signin"),
};

let session = null;
let viewerId = null;
let currentRecordId = null;
let currentOwnerId = null;
let likedByMe = false;
let likeTotal = 0;
let fetchToken = 0;

export async function initSocial() {
  if (!els.strip) {
    return;
  }

  session = await getSession();
  viewerId = session?.user?.id || null;

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

  els.pingButton.addEventListener("click", () => {
    if (!viewerId) {
      loginHere();
      return;
    }
    els.pingForm.hidden = !els.pingForm.hidden;
    els.pingStatus.textContent = "";
  });

  els.pingSend.addEventListener("click", async () => {
    if (!currentRecordId) return;
    els.pingSend.disabled = true;
    els.pingStatus.textContent = "Sending…";

    try {
      const { data } = await supabase.auth.getSession();
      const response = await fetch("/api/ping", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.session?.access_token || ""}`,
        },
        body: JSON.stringify({
          recordId: currentRecordId,
          message: els.pingMessage.value.trim() || undefined,
          includeEmail: els.pingShareEmail.checked,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Error ${response.status}`);
      els.pingStatus.textContent = payload.message || "Sent!";
      els.pingMessage.value = "";
      setTimeout(() => {
        els.pingForm.hidden = true;
      }, 2500);
    } catch (error) {
      els.pingStatus.textContent = error.message;
    } finally {
      els.pingSend.disabled = false;
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
}

// Called whenever the active record changes. `record.id` is the row uuid.
export async function renderSocial(record, ownerId) {
  if (!els.strip) {
    return;
  }

  const token = ++fetchToken;

  if (!record) {
    els.strip.hidden = true;
    els.commentsPanel.hidden = true;
    return;
  }

  currentRecordId = record.id;
  currentOwnerId = ownerId;
  els.strip.hidden = false;
  els.commentsPanel.hidden = false;
  els.pingForm.hidden = true;
  els.pingButton.hidden = !viewerId || viewerId === ownerId;
  els.commentForm.hidden = !viewerId;
  els.commentsSignin.hidden = Boolean(viewerId);

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
