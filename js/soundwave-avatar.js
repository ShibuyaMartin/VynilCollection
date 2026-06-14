// Deterministic default avatar: a curved-vector sound wave, seeded by the
// user id/username so each person gets a unique-but-stable identicon. No
// photo, no external lib — just an inline SVG of layered wave paths in the
// Deadwax palette. Used wherever an avatar shows when avatar_path is empty.

const INK = "#f3ede3";

// xmur3 string hash → a deterministic 32-bit seed.
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

// Returns an SVG string: concentric/stacked sine waves whose amplitude,
// frequency, phase and stroke count derive from the seed.
export function soundwaveAvatarSvg(seed, size = 96) {
  const rand = hashSeed(String(seed || "deadwax"));
  const W = 100;
  const H = 100;
  const lines = 3 + Math.floor(rand() * 3); // 3–5 waves
  const baseFreq = 1.4 + rand() * 2.6; // cycles across the width
  const phase = rand() * Math.PI * 2;
  const paths = [];

  for (let i = 0; i < lines; i += 1) {
    const t = lines === 1 ? 0.5 : i / (lines - 1);
    const midY = 24 + t * 52; // spread the baselines vertically
    const amp = 6 + rand() * 16;
    const freq = baseFreq * (0.7 + rand() * 0.6);
    const ph = phase + i * (0.6 + rand());
    const opacity = (0.35 + 0.65 * (1 - Math.abs(t - 0.5) * 2)).toFixed(2);
    const width = (1 + rand() * 1.6).toFixed(2);

    let d = "";
    const step = 4;
    for (let x = 0; x <= W; x += step) {
      const y = midY + Math.sin((x / W) * Math.PI * 2 * freq + ph) * amp;
      d += `${x === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    paths.push(
      `<path d="${d.trim()}" fill="none" stroke="${INK}" stroke-width="${width}" stroke-linecap="round" opacity="${opacity}"/>`
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${size}" height="${size}" ` +
    `role="img" aria-label="Avatar" preserveAspectRatio="xMidYMid slice">` +
    paths.join("") +
    `</svg>`
  );
}

// A ready-to-use data URL, handy for <img src> or background-image.
export function soundwaveAvatarDataUrl(seed, size = 96) {
  return `data:image/svg+xml,${encodeURIComponent(soundwaveAvatarSvg(seed, size))}`;
}
