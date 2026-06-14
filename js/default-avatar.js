// Default avatar: DiceBear "thumbs" rendered black & white — a cream thumb
// shape with black eyes/mouth on a transparent background, so it sits on the
// Deadwax black. Deterministic per seed (user's avatar_seed or username).
// Served straight from DiceBear's HTTP API as an <img src> (no build step).

const BASE = "https://api.dicebear.com/10.x/thumbs/svg";

export function defaultAvatarUrl(seed) {
  const params = new URLSearchParams({
    seed: String(seed || "deadwax"),
    backgroundColor: "00000000", // transparent
    shapeColor: "f3ede3", // var(--text)
  });
  return `${BASE}?${params}`;
}
