// Deterministic default avatar: a fanned bundle of fine curved lines whose
// envelope pinches and swells — a generative "standing wave" seeded by the
// user id/username, so each person gets a unique-but-stable identicon. No
// photo, no external lib — inline SVG in the Deadwax B&W palette, square.

const INK = "243, 237, 227"; // var(--text) as rgb, for per-line opacity

// xmur3 string hash → deterministic 32-bit seed → [0,1) generator.
function makeRng(str) {
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

// Square SVG string. `size` is the rendered px; the viewBox is fixed at 100.
export function soundwaveAvatarSvg(seed, size = 96) {
  const rand = makeRng(String(seed || "deadwax"));
  const V = 100;
  const cx = V / 2;
  const maxW = 46;

  const lines = 20 + Math.floor(rand() * 12); // 20–31 strands — readable when tiny
  const lobes = 2 + Math.floor(rand() * 2); // 2–3 swells stacked in the square
  const phase = rand() * Math.PI * 2;
  const wob = 0.3 + rand() * 0.4; // swell-size variation
  const wobFreq = 0.5 + rand() * 1;
  const stroke = (0.6 + rand() * 0.3).toFixed(2);

  const steps = 90;
  const paths = [];
  for (let i = 0; i < lines; i += 1) {
    const a = lines === 1 ? 0 : (i / (lines - 1)) * 2 - 1; // -1..1 fan
    let d = "";
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const env = Math.sin(Math.PI * t * lobes);
      const sizeMod = 0.6 + wob * Math.sin(Math.PI * t * lobes * wobFreq + phase);
      const x = cx + a * maxW * env * sizeMod;
      const y = t * V;
      d += `${s === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    const op = (0.22 + 0.55 * Math.abs(a)).toFixed(2);
    paths.push(
      `<path d="${d.trim()}" fill="none" stroke="rgba(${INK},${op})" stroke-width="${stroke}"/>`
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${V} ${V}" width="${size}" height="${size}" ` +
    `role="img" aria-label="Avatar">${paths.join("")}</svg>`
  );
}

// A ready-to-use data URL, handy for <img src> or background-image.
export function soundwaveAvatarDataUrl(seed, size = 96) {
  return `data:image/svg+xml,${encodeURIComponent(soundwaveAvatarSvg(seed, size))}`;
}
