// Social layer: likes and comments per record, plus following the
// collection's owner. Everything talks straight to Supabase under RLS.

import { supabase } from "/js/supabase-client.js";
import { getSession, getOwnProfile } from "/js/auth.js";

const els = {
  strip: document.getElementById("social-strip"),
  likeButton: document.getElementById("like-button"),
  likeCount: document.getElementById("like-count"),
  followButton: document.getElementById("follow-button"),
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
