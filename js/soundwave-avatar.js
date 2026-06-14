// Deterministic default avatar: a little ASCII "martian" — a left-right
// symmetric invader with a guaranteed face (eyes, sometimes a mouth and
// antennae), seeded by the user id/username so each person gets a
// unique-but-stable creature. Inline SVG monospace text, Deadwax B&W.
// (Export name kept as soundwaveAvatarSvg so existing imports still work.)

const INK = "#f3ede3";
const FILLS = ["#", "@", "%", "&", "*", "0", "8", "$", "+", "=", "M", "W"];
const EYES = ["o", "O", "0", "*", "x", "^", "-", "•", "□", "▪"];

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

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

// Build a COLS×ROWS character grid: a symmetric body filled with one glyph,
// with eyes carved/placed and optional antennae + mouth.
function buildMartian(rand) {
  const COLS = 7;
  const ROWS = 7;
  const half = Math.floor(COLS / 2); // center column index
  const fill = pick(rand, FILLS);
  const eye = pick(rand, EYES);
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(" "));

  // Body: random symmetric blob, denser in the middle rows.
  for (let y = 1; y < ROWS; y += 1) {
    const bias = y === ROWS - 1 ? 0.4 : 0.62;
    for (let x = 0; x <= half; x += 1) {
      if (rand() < bias) {
        grid[y][x] = fill;
        grid[y][COLS - 1 - x] = fill;
      }
    }
  }

  // Antennae: top row, symmetric, ~70% of the time.
  if (rand() < 0.7) {
    const ax = 1 + Math.floor(rand() * (half - 1)); // 1..half-1
    grid[0][ax] = fill;
    grid[0][COLS - 1 - ax] = fill;
  }

  // Eyes: a guaranteed symmetric pair on an upper-middle row, so it reads
  // as a face. Off-center so they sit either side of the centre line.
  const eyeRow = 2 + Math.floor(rand() * 2); // row 2 or 3
  const eyeX = half - 1; // one step left of centre
  grid[eyeRow][eyeX] = eye;
  grid[eyeRow][COLS - 1 - eyeX] = eye;
  grid[eyeRow][half] = " "; // keep the bridge clear

  // Mouth: short centred mark a row or two below the eyes, sometimes.
  if (rand() < 0.6) {
    const mouthRow = Math.min(ROWS - 1, eyeRow + 2);
    grid[mouthRow][half] = rand() < 0.5 ? "_" : "=";
  }

  return grid.map((row) => row.join("").replace(/\s+$/u, ""));
}

export function soundwaveAvatarSvg(seed, size = 96) {
  const rand = makeRng(String(seed || "deadwax"));
  const lines = buildMartian(rand);
  const rows = lines.length;
  const lh = 100 / (rows + 0.6);
  const fontSize = lh * 1.02;

  const tspans = lines
    .map((line, i) => {
      const safe = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<tspan x="50" dy="${i === 0 ? lh * 0.9 : lh}">${safe || " "}</tspan>`;
    })
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="Avatar">` +
    `<text x="50" y="0" fill="${INK}" font-family="Geist Mono, ui-monospace, monospace" font-size="${fontSize.toFixed(2)}" ` +
    `font-weight="600" text-anchor="middle" xml:space="preserve" letter-spacing="0.5">${tspans}</text></svg>`
  );
}

export function soundwaveAvatarDataUrl(seed, size = 96) {
  return `data:image/svg+xml,${encodeURIComponent(soundwaveAvatarSvg(seed, size))}`;
}
