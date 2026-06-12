// Splash/loading screen: an ink-style WebGL title card shown while the
// collection loads. Hand-rolled approximation of a basement.studio ShaderLab
// composition (ink text + neon gradient + grain + bloom) without React/npm.

const SPLASH_TEXT = "audiophile";
const MIN_DURATION_MS = 1500;
const MAX_DURATION_MS = 4000;
const FADE_MS = 600;

const splash = document.getElementById("splash");
const canvas = document.getElementById("splash-canvas");

if (splash && canvas) {
  runSplash().catch(() => hideSplash());
}

async function runSplash() {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
  if (!gl) {
    hideSplash();
    return;
  }

  const startedAt = performance.now();

  // Hide when the collection is ready AND the minimum time has elapsed —
  // or unconditionally at the hard timeout.
  let collectionReady = false;
  document.addEventListener("collection:ready", () => {
    collectionReady = true;
  });
  const tryHide = () => {
    const elapsed = performance.now() - startedAt;
    if (elapsed >= MAX_DURATION_MS || (collectionReady && elapsed >= MIN_DURATION_MS)) {
      hideSplash();
      return true;
    }
    return false;
  };

  // Wait briefly for the mono font so the title doesn't render in a fallback.
  try {
    await Promise.race([
      document.fonts.load('600 100px "Geist Mono"'),
      new Promise((resolve) => setTimeout(resolve, 350)),
    ]);
  } catch {
    // Fallback font is fine.
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.floor(window.innerWidth * dpr);
  const height = Math.floor(window.innerHeight * dpr);
  canvas.width = width;
  canvas.height = height;

  const textTexture = createTextTexture(gl, width, height, dpr);
  const program = createProgram(gl);
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const positionLocation = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, textTexture);
  gl.uniform1i(gl.getUniformLocation(program, "u_text"), 0);
  gl.uniform2f(gl.getUniformLocation(program, "u_res"), width, height);
  const timeLocation = gl.getUniformLocation(program, "u_time");
  const progressLocation = gl.getUniformLocation(program, "u_progress");

  gl.viewport(0, 0, width, height);

  const frame = () => {
    if (splash.classList.contains("splash--hidden")) {
      return;
    }
    const elapsed = (performance.now() - startedAt) / 1000;
    gl.uniform1f(timeLocation, elapsed);
    gl.uniform1f(progressLocation, Math.min(elapsed / 1.1, 1));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!tryHide()) {
      requestAnimationFrame(frame);
    }
  };
  requestAnimationFrame(frame);
}

function hideSplash() {
  if (!splash || splash.classList.contains("splash--hidden")) {
    return;
  }
  splash.classList.add("splash--hidden");
  setTimeout(() => splash.remove(), FADE_MS + 80);
}

function createTextTexture(gl, width, height, dpr) {
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const context = source.getContext("2d");
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#fff";
  const fontSize = Math.min(width * 0.115, 120 * dpr);
  context.font = `600 ${fontSize}px "Geist Mono", monospace`;
  try {
    context.letterSpacing = `${fontSize * 0.07}px`;
  } catch {
    // Older browsers: no letter spacing.
  }
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(SPLASH_TEXT, width / 2, height / 2);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function createProgram(gl) {
  const vertexSource = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const fragmentSource = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_text;
    uniform vec2 u_res;
    uniform float u_time;
    uniform float u_progress;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }

    float fbm(vec2 p) {
      float v = 0.0;
      v += 0.5 * noise(p);
      v += 0.25 * noise(p * 2.1 + 13.0);
      v += 0.125 * noise(p * 4.3 + 29.0);
      return v;
    }

    void main() {
      vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
      float aspect = u_res.x / u_res.y;

      // Ink: vertical bleed driven by noise, plus a soft multi-tap blur.
      float drip = fbm(vec2(uv.x * 9.0 * aspect, u_time * 0.45));
      vec2 dripUv = uv - vec2(0.0, drip * drip * 0.09);

      float ink = 0.0;
      float total = 0.0;
      for (int s = -6; s <= 6; s++) {
        float fs = float(s);
        float w = 1.0 - abs(fs) / 7.0;
        vec2 offset = vec2(0.0, fs * 0.0022 * (0.4 + drip));
        ink += texture2D(u_text, dripUv + offset).r * w;
        total += w;
      }
      ink /= total;
      float crisp = texture2D(u_text, dripUv).r;
      ink = max(ink * 1.35, crisp);

      // Reveal: ink soaks in over u_progress, gated by noise.
      float gate = fbm(uv * 5.0 + 3.7);
      ink *= smoothstep(gate - 0.35, gate + 0.05, u_progress * 1.3);

      // Gradient colorization: edge -> mid -> core.
      vec3 edgeColor = vec3(0.443, 0.573, 0.945);  /* #7192F1 */
      vec3 midColor = vec3(0.624);                 /* #9F9F9F */
      vec3 coreColor = vec3(1.0, 0.992, 0.910);    /* #fffde8 */
      vec3 inkColor = mix(edgeColor, midColor, smoothstep(0.08, 0.45, ink));
      inkColor = mix(inkColor, coreColor, smoothstep(0.45, 0.85, ink));

      // Neon background glow, warped by noise (very low opacity).
      vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
      float warp = fbm(p * 3.0 + u_time * 0.25);
      float blobPink = exp(-3.5 * length(p - vec2(-0.62, -0.32) + warp * 0.22));
      float blobTeal = exp(-3.5 * length(p - vec2(0.66, 0.26) - warp * 0.18));
      float blobRed = exp(-4.0 * length(p - vec2(-0.2, 0.42) + warp * 0.15));
      vec3 bg = vec3(1.0, 0.745, 0.745) * blobPink * 0.10
              + vec3(0.0, 0.533, 0.667) * blobTeal * 0.10
              + vec3(0.722, 0.0, 0.314) * blobRed * 0.08;

      // Bloom-ish lift on bright ink + film grain.
      float bloom = smoothstep(0.6, 1.0, ink) * 0.35;
      float grain = (hash(uv * u_res + u_time * 60.0) - 0.5) * 0.05;

      vec3 color = bg + inkColor * ink + coreColor * bloom + grain;

      // Vignette.
      color *= 1.0 - 0.55 * dot(p, p);

      gl_FragColor = vec4(color, 1.0);
    }
  `;

  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragmentSource],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "Shader compile failed");
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "Program link failed");
  }
  return program;
}
