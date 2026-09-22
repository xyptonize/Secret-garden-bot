// Profile-card backgrounds, drawn in code — no image files to host or lose.
//
// Each background is a draw(ctx) over a 960x320 canvas, grouped into CS2-style
// rarities. Drawing is deterministic (seeded RNG, no Math.random), so the same
// background always looks the same and a card can be re-rendered any time from
// just its id.

export const CARD_W = 960;
export const CARD_H = 320;

/** CS2 case odds, commonest first. `dupe` is what a duplicate pays in coins. */
export const RARITIES = [
  { key: 'milspec', name: 'Mil-Spec', color: 0x4b69ff, odds: 0.7992, dupe: 20, emoji: '🔵' },
  { key: 'restricted', name: 'Restricted', color: 0x8847ff, odds: 0.1598, dupe: 60, emoji: '🟣' },
  { key: 'classified', name: 'Classified', color: 0xd32ce6, odds: 0.032, dupe: 200, emoji: '🩷' },
  { key: 'covert', name: 'Covert', color: 0xeb4b4b, odds: 0.0064, dupe: 700, emoji: '🔴' },
  { key: 'rare', name: 'Exceedingly Rare', color: 0xffd700, odds: 0.0026, dupe: 2500, emoji: '🟡' },
];

export const rarityOf = (key) => RARITIES.find((r) => r.key === key) ?? RARITIES[0];
export const rarityRank = (key) => Math.max(0, RARITIES.findIndex((r) => r.key === key));

// --- small drawing helpers -------------------------------------------------

/** Deterministic pseudo-random, so a background never changes between renders. */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** '#rrggbb' + alpha -> 'rgba(r, g, b, a)'. */
function rgba(color, alpha) {
  const n = parseInt(color.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function linear(ctx, stops, { x0 = 0, y0 = 0, x1 = CARD_W, y1 = 0 } = {}) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
}

function glow(ctx, x, y, r, color, alpha = 0.55) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.5, rgba(color, alpha * 0.35));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function stars(ctx, count, seed, color = '#ffffff', max = 1.8) {
  const r = rng(seed);
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = r() * CARD_W;
    const y = r() * CARD_H;
    ctx.globalAlpha = 0.2 + r() * 0.7;
    ctx.beginPath();
    ctx.arc(x, y, r() * max + 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function grid(ctx, step, color, alpha = 0.18, skew = 0) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let x = -CARD_H; x < CARD_W + CARD_H; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + skew, CARD_H);
    ctx.stroke();
  }
  for (let y = 0; y <= CARD_H; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(CARD_W, y);
    ctx.stroke();
  }
  ctx.restore();
}

function waves(ctx, { color, amp, freq, lines, seed, alpha = 0.35, width = 2 }) {
  const r = rng(seed);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  for (let i = 0; i < lines; i++) {
    const offset = r() * CARD_H;
    ctx.beginPath();
    for (let x = 0; x <= CARD_W; x += 8) {
      const y = offset + Math.sin((x / CARD_W) * freq * Math.PI * 2 + i) * amp;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function rays(ctx, { x, y, count, color, seed, alpha = 0.25, length = 1400 }) {
  const r = rng(seed);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2;
    const spread = 0.015 + r() * 0.05;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a - spread) * length, y + Math.sin(a - spread) * length);
    ctx.lineTo(x + Math.cos(a + spread) * length, y + Math.sin(a + spread) * length);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function ridge(ctx, { color, base, height, steps, seed, alpha = 1 }) {
  const r = rng(seed);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, CARD_H);
  for (let x = 0; x <= CARD_W + 1; x += CARD_W / steps) {
    ctx.lineTo(x, base - r() * height);
  }
  ctx.lineTo(CARD_W, CARD_H);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function scanlines(ctx, step = 4, alpha = 0.12) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#000000';
  for (let y = 0; y < CARD_H; y += step) ctx.fillRect(0, y, CARD_W, step / 2);
  ctx.restore();
}

function speckle(ctx, count, seed, color = '#ffffff', alpha = 0.18) {
  const r = rng(seed);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) ctx.fillRect(r() * CARD_W, r() * CARD_H, 2, 2);
  ctx.restore();
}

function hexes(ctx, { size, color, alpha = 0.16, width = 1.5 }) {
  const h = size * Math.sqrt(3);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  for (let col = 0, x = 0; x < CARD_W + size * 2; col++, x += size * 1.5) {
    for (let y = (col % 2) * (h / 2); y < CARD_H + h; y += h) {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        const px = x + Math.cos(a) * size;
        const py = y + Math.sin(a) * size;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Right-angled traces with a lit node at the end, like a circuit board. */
function traces(ctx, { count, color, seed, alpha = 0.5 }) {
  const r = rng(seed);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (let i = 0; i < count; i++) {
    let x = Math.round((r() * CARD_W) / 20) * 20;
    let y = Math.round((r() * CARD_H) / 20) * 20;
    ctx.globalAlpha = alpha * (0.4 + r() * 0.6);
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0, steps = 2 + Math.floor(r() * 4); s < steps; s++) {
      if (s % 2 === 0) x += (r() < 0.5 ? -1 : 1) * (40 + Math.floor(r() * 6) * 20);
      else y += (r() < 0.5 ? -1 : 1) * (20 + Math.floor(r() * 3) * 20);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** A jagged bolt from (x,y) travelling in direction `angle`. */
function bolt(ctx, { x, y, angle, length, color, seed, width = 2 }) {
  const r = rng(seed);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, y);
  let cx = x;
  let cy = y;
  const step = length / 8;
  for (let i = 0; i < 8; i++) {
    const a = angle + (r() - 0.5) * 1.1;
    cx += Math.cos(a) * step;
    cy += Math.sin(a) * step;
    ctx.lineTo(cx, cy);
  }
  ctx.stroke();
  ctx.restore();
}

function petals(ctx, { count, color, seed, alpha = 0.75 }) {
  const r = rng(seed);
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = r() * CARD_W;
    const y = r() * CARD_H;
    const size = 4 + r() * 9;
    ctx.globalAlpha = alpha * (0.35 + r() * 0.65);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(r() * Math.PI * 2);
    ctx.beginPath();
    ctx.ellipse(0, 0, size, size * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function embers(ctx, { count, seed, colors = ['#ffd27a', '#ff8a3c', '#ff5028'] }) {
  const r = rng(seed);
  ctx.save();
  for (let i = 0; i < count; i++) {
    const x = r() * CARD_W;
    const y = r() * CARD_H;
    const size = 1 + r() * 3.5;
    ctx.globalAlpha = 0.25 + r() * 0.7;
    ctx.fillStyle = colors[Math.floor(r() * colors.length)];
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Four-pointed sparkles, the "this one is special" garnish. */
function sparkles(ctx, { count, seed, color = '#fff6c9' }) {
  const r = rng(seed);
  ctx.save();
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = r() * CARD_W;
    const y = r() * CARD_H;
    const s = 4 + r() * 12;
    ctx.globalAlpha = 0.35 + r() * 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.quadraticCurveTo(x, y, x + s, y);
    ctx.quadraticCurveTo(x, y, x, y + s);
    ctx.quadraticCurveTo(x, y, x - s, y);
    ctx.quadraticCurveTo(x, y, x, y - s);
    ctx.fill();
  }
  ctx.restore();
}

/** A leafy vine along a curve — the Secret Garden motif. */
function vine(ctx, { x0, y0, x1, y1, bow, color, leaf, seed, width = 3 }) {
  const r = rng(seed);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2 + bow;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(cx, cy, x1, y1);
  ctx.stroke();
  ctx.fillStyle = leaf;
  for (let t = 0.08; t < 0.95; t += 0.07) {
    const px = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1;
    const py = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1;
    const size = 7 + r() * 7;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(r() * Math.PI * 2);
    ctx.beginPath();
    ctx.ellipse(0, 0, size, size * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** Darkens the left side so the avatar and name stay readable on any art. */
export function readability(ctx) {
  const g = ctx.createLinearGradient(0, 0, CARD_W, 0);
  g.addColorStop(0, 'rgba(0, 0, 0, 0.72)');
  g.addColorStop(0.55, 'rgba(0, 0, 0, 0.45)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0.18)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
}

// --- the backgrounds -------------------------------------------------------

export const BACKGROUNDS = [
  // ---------- Mil-Spec (blue) ----------
  {
    id: 'midnight',
    name: 'Midnight Slope',
    rarity: 'milspec',
    draw(ctx) {
      linear(ctx, [[0, '#0f2027'], [0.5, '#203a43'], [1, '#2c5364']], { x1: CARD_W, y1: CARD_H });
      stars(ctx, 70, 3);
      ridge(ctx, { color: '#16222c', base: CARD_H * 0.88, height: 90, steps: 14, seed: 7 });
      ridge(ctx, { color: '#0d151b', base: CARD_H * 0.98, height: 55, steps: 9, seed: 21 });
    },
  },
  {
    id: 'concrete',
    name: 'Concrete Jungle',
    rarity: 'milspec',
    draw(ctx) {
      linear(ctx, [[0, '#3e4a54'], [1, '#1b2126']], { x1: 0, y1: CARD_H });
      grid(ctx, 48, '#9fb3c0', 0.13, 40);
      speckle(ctx, 500, 5, '#ffffff', 0.05);
    },
  },
  {
    id: 'deepcurrent',
    name: 'Deep Current',
    rarity: 'milspec',
    draw(ctx) {
      linear(ctx, [[0, '#0b2f4a'], [1, '#04101c']], { x1: 0, y1: CARD_H });
      glow(ctx, CARD_W * 0.8, -40, 380, '#2e9bd6', 0.35);
      waves(ctx, { color: '#5fc8ff', amp: 26, freq: 2.2, lines: 8, seed: 11, alpha: 0.28 });
    },
  },
  {
    id: 'static',
    name: 'Static Field',
    rarity: 'milspec',
    draw(ctx) {
      linear(ctx, [[0, '#1b2735'], [1, '#090a0f']], { x1: CARD_W, y1: CARD_H });
      glow(ctx, CARD_W * 0.72, CARD_H * 0.4, 340, '#4b8cff', 0.3);
      speckle(ctx, 2200, 13, '#bcdcff', 0.28);
      waves(ctx, { color: '#7fb6ff', amp: 8, freq: 9, lines: 4, seed: 19, alpha: 0.22, width: 1.5 });
      scanlines(ctx, 5, 0.2);
    },
  },
  {
    id: 'bluehour',
    name: 'Blue Hour',
    rarity: 'milspec',
    draw(ctx) {
      linear(ctx, [[0, '#0a1b3d'], [0.6, '#27548f'], [1, '#7aa7c7']], { x1: 0, y1: CARD_H });
      glow(ctx, CARD_W * 0.25, CARD_H * 0.95, 300, '#ffd9a0', 0.4);
      ridge(ctx, { color: '#0a1524', base: CARD_H * 0.95, height: 40, steps: 10, seed: 31 });
    },
  },
  {
    id: 'hexfield',
    name: 'Hex Field',
    rarity: 'milspec',
    draw(ctx) {
      linear(ctx, [[0, '#16323f'], [1, '#0a1419']], { x1: CARD_W, y1: CARD_H });
      hexes(ctx, { size: 26, color: '#57b6c9', alpha: 0.2 });
      glow(ctx, CARD_W * 0.7, CARD_H * 0.5, 320, '#57b6c9', 0.22);
    },
  },
  {
    id: 'gardenfog',
    name: 'Garden Fog',
    rarity: 'milspec',
    draw(ctx) {
      linear(ctx, [[0, '#13322a'], [1, '#07130f']], { x1: 0, y1: CARD_H });
      glow(ctx, CARD_W * 0.2, CARD_H * 0.3, 260, '#4fd1a5', 0.28);
      glow(ctx, CARD_W * 0.75, CARD_H * 0.7, 300, '#2f8f7a', 0.3);
      speckle(ctx, 300, 17, '#bff7e0', 0.12);
    },
  },

  // ---------- Restricted (purple) ----------
  {
    id: 'neongrid',
    name: 'Neon Grid',
    rarity: 'restricted',
    draw(ctx) {
      linear(ctx, [[0, '#1a0033'], [0.55, '#54126b'], [1, '#ff6ec7']], { x1: 0, y1: CARD_H });
      glow(ctx, CARD_W / 2, CARD_H * 0.62, 220, '#ffd166', 0.55);
      ctx.save();
      ctx.strokeStyle = '#ff6ec7';
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 2;
      const horizon = CARD_H * 0.62;
      for (let i = -12; i <= 12; i++) {
        ctx.beginPath();
        ctx.moveTo(CARD_W / 2 + i * 22, horizon);
        ctx.lineTo(CARD_W / 2 + i * 190, CARD_H);
        ctx.stroke();
      }
      for (let y = horizon, step = 4; y < CARD_H; step *= 1.45, y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(CARD_W, y);
        ctx.stroke();
      }
      ctx.restore();
    },
  },
  {
    id: 'violetbloom',
    name: 'Violet Bloom',
    rarity: 'restricted',
    draw(ctx) {
      linear(ctx, [[0, '#2b0b4d'], [1, '#0b0316']], { x1: CARD_W, y1: CARD_H });
      const r = rng(41);
      for (let i = 0; i < 14; i++) {
        glow(ctx, r() * CARD_W, r() * CARD_H, 40 + r() * 90, i % 3 === 0 ? '#ff9de2' : '#a05cff', 0.3);
      }
      speckle(ctx, 260, 43, '#e9d7ff', 0.16);
    },
  },
  {
    id: 'circuit',
    name: 'Circuit Break',
    rarity: 'restricted',
    draw(ctx) {
      linear(ctx, [[0, '#1c1040'], [1, '#08040f']], { x1: 0, y1: CARD_H });
      grid(ctx, 20, '#6b4bd6', 0.08);
      traces(ctx, { count: 26, color: '#b78bff', seed: 53, alpha: 0.75 });
      glow(ctx, CARD_W * 0.85, CARD_H * 0.25, 260, '#8847ff', 0.3);
    },
  },
  {
    id: 'auroradrift',
    name: 'Aurora Drift',
    rarity: 'restricted',
    draw(ctx) {
      linear(ctx, [[0, '#07031a'], [1, '#160b33']], { x1: 0, y1: CARD_H });
      stars(ctx, 110, 59);
      ctx.save();
      ctx.globalAlpha = 0.5;
      for (const [color, offset, amp] of [['#7af7c8', 90, 34], ['#8a6bff', 140, 46], ['#ff8ae2', 190, 28]]) {
        const g = ctx.createLinearGradient(0, offset - 70, 0, offset + 70);
        g.addColorStop(0, rgba(color, 0));
        g.addColorStop(0.5, rgba(color, 0.75));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, offset - 70);
        for (let x = 0; x <= CARD_W; x += 10) ctx.lineTo(x, offset - 70 + Math.sin(x / 150 + offset) * amp);
        for (let x = CARD_W; x >= 0; x -= 10) ctx.lineTo(x, offset + 70 + Math.sin(x / 120 + offset) * amp);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    },
  },
  {
    id: 'prism',
    name: 'Prism Wave',
    rarity: 'restricted',
    draw(ctx) {
      linear(ctx, [[0, '#120726'], [1, '#04020a']], { x1: CARD_W, y1: 0 });
      ctx.save();
      ctx.globalAlpha = 0.55;
      const bands = ['#5b2ce0', '#8847ff', '#c06bff', '#ff7ad9', '#6ee0ff'];
      bands.forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        const x = -120 + i * 150;
        ctx.moveTo(x, 0);
        ctx.lineTo(x + 90, 0);
        ctx.lineTo(x + 90 + 220, CARD_H);
        ctx.lineTo(x + 220, CARD_H);
        ctx.closePath();
        ctx.fill();
      });
      ctx.restore();
      glow(ctx, CARD_W * 0.15, CARD_H * 0.2, 240, '#ffffff', 0.18);
    },
  },
  {
    id: 'vortex',
    name: 'Violet Vortex',
    rarity: 'restricted',
    draw(ctx) {
      linear(ctx, [[0, '#0d0520'], [1, '#2a0f4f']], { x1: CARD_W, y1: CARD_H });
      const cx = CARD_W * 0.72;
      const cy = CARD_H * 0.5;
      glow(ctx, cx, cy, 300, '#8847ff', 0.45);
      ctx.save();
      ctx.strokeStyle = '#d9b8ff';
      ctx.lineWidth = 2;
      for (let i = 0; i < 26; i++) {
        ctx.globalAlpha = 0.35 - i * 0.008;
        ctx.beginPath();
        ctx.arc(cx, cy, 24 + i * 15, i * 0.35, i * 0.35 + 2.2);
        ctx.stroke();
      }
      ctx.restore();
      stars(ctx, 60, 67, '#e5d4ff');
    },
  },

  // ---------- Classified (pink) ----------
  {
    id: 'plasma',
    name: 'Plasma Coil',
    rarity: 'classified',
    draw(ctx) {
      linear(ctx, [[0, '#1a0526'], [1, '#050109']], { x1: 0, y1: CARD_H });
      const cx = CARD_W * 0.72;
      const cy = CARD_H * 0.48;
      glow(ctx, cx, cy, 260, '#d32ce6', 0.6);
      for (let i = 0; i < 14; i++) {
        bolt(ctx, {
          x: cx,
          y: cy,
          angle: (Math.PI * 2 * i) / 14,
          length: 150 + (i % 4) * 45,
          color: i % 3 === 0 ? '#ffffff' : '#ff7af0',
          seed: 71 + i * 13,
          width: i % 3 === 0 ? 1.4 : 2.2,
        });
      }
      speckle(ctx, 220, 79, '#ffc8f7', 0.2);
    },
  },
  {
    id: 'orchid',
    name: 'Orchid Nebula',
    rarity: 'classified',
    draw(ctx) {
      linear(ctx, [[0, '#0a0212'], [1, '#1b0730']], { x1: CARD_W, y1: CARD_H });
      const r = rng(83);
      for (let i = 0; i < 18; i++) {
        const color = ['#d32ce6', '#7b5cff', '#ff5fa2', '#3fd0ff'][Math.floor(r() * 4)];
        glow(ctx, r() * CARD_W, r() * CARD_H, 70 + r() * 150, color, 0.28);
      }
      stars(ctx, 200, 89, '#ffffff', 2.2);
      sparkles(ctx, { count: 6, seed: 97, color: '#ffd9f5' });
    },
  },
  {
    id: 'hyperline',
    name: 'Hyperline',
    rarity: 'classified',
    draw(ctx) {
      linear(ctx, [[0, '#12021c'], [1, '#2b0533']], { x1: 0, y1: CARD_H });
      const cx = CARD_W * 0.78;
      const cy = CARD_H * 0.5;
      const r = rng(101);
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 0; i < 90; i++) {
        const a = r() * Math.PI * 2;
        const near = 40 + r() * 180;
        const far = near + 60 + r() * 220;
        ctx.globalAlpha = 0.15 + r() * 0.6;
        ctx.strokeStyle = r() < 0.3 ? '#ffffff' : '#ff6ed8';
        ctx.lineWidth = 1 + r() * 2.5;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * near, cy + Math.sin(a) * near);
        ctx.lineTo(cx + Math.cos(a) * far, cy + Math.sin(a) * far);
        ctx.stroke();
      }
      ctx.restore();
      glow(ctx, cx, cy, 130, '#ffffff', 0.5);
    },
  },
  {
    id: 'sakura',
    name: 'Sakura Drift',
    rarity: 'classified',
    draw(ctx) {
      linear(ctx, [[0, '#3b0f2e'], [0.55, '#7a2352'], [1, '#c76a95']], { x1: 0, y1: CARD_H });
      glow(ctx, CARD_W * 0.8, CARD_H * 0.2, 300, '#ffd1e8', 0.35);
      petals(ctx, { count: 90, color: '#ffd7ea', seed: 103, alpha: 0.85 });
      petals(ctx, { count: 40, color: '#ff8fc0', seed: 107, alpha: 0.7 });
    },
  },

  // ---------- Covert (red) ----------
  {
    id: 'inferno',
    name: 'Inferno Rush',
    rarity: 'covert',
    draw(ctx) {
      linear(ctx, [[0, '#170202'], [0.6, '#5c0d05'], [1, '#c2340d']], { x1: 0, y1: CARD_H });
      glow(ctx, CARD_W * 0.5, CARD_H * 1.05, 420, '#ff8a2b', 0.6);
      ridge(ctx, { color: '#1c0503', base: CARD_H, height: 70, steps: 16, seed: 109, alpha: 0.85 });
      embers(ctx, { count: 200, seed: 113 });
    },
  },
  {
    id: 'eclipse',
    name: 'Crimson Eclipse',
    rarity: 'covert',
    draw(ctx) {
      linear(ctx, [[0, '#0a0204'], [1, '#26060b']], { x1: CARD_W, y1: CARD_H });
      stars(ctx, 120, 127, '#ffd9d9');
      const cx = CARD_W * 0.74;
      const cy = CARD_H * 0.46;
      rays(ctx, { x: cx, y: cy, count: 26, color: '#ff3b3b', seed: 131, alpha: 0.16 });
      glow(ctx, cx, cy, 190, '#ff2d2d', 0.75);
      ctx.fillStyle = '#080204';
      ctx.beginPath();
      ctx.arc(cx, cy, 86, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ff6a4d';
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.globalAlpha = 1;
    },
  },
  {
    id: 'molten',
    name: 'Molten Core',
    rarity: 'covert',
    draw(ctx) {
      linear(ctx, [[0, '#2a0a06'], [1, '#0a0302']], { x1: 0, y1: CARD_H });
      const r = rng(137);
      // Lava seams glowing through cracked rock.
      for (let i = 0; i < 16; i++) {
        const x = r() * CARD_W;
        const y = r() * CARD_H;
        ctx.save();
        ctx.strokeStyle = '#ff6a1a';
        ctx.shadowColor = '#ff9a3c';
        ctx.shadowBlur = 18;
        ctx.lineWidth = 1 + r() * 3;
        ctx.globalAlpha = 0.5 + r() * 0.5;
        bolt(ctx, { x, y, angle: r() * Math.PI * 2, length: 120 + r() * 220, color: '#ff8a2a', seed: 139 + i * 7, width: ctx.lineWidth });
        ctx.restore();
      }
      glow(ctx, CARD_W * 0.3, CARD_H * 0.7, 260, '#ff4d00', 0.35);
      embers(ctx, { count: 120, seed: 149 });
    },
  },

  // ---------- Exceedingly Rare (gold) ----------
  {
    id: 'goldengarden',
    name: 'Golden Garden',
    rarity: 'rare',
    draw(ctx) {
      linear(ctx, [[0, '#07130c'], [0.55, '#123020'], [1, '#3d2f06']], { x1: CARD_W, y1: CARD_H });
      // Late sun through the garden, low and to the right.
      glow(ctx, CARD_W * 0.82, CARD_H * 0.78, 420, '#ffb43c', 0.5);
      glow(ctx, CARD_W * 0.82, CARD_H * 0.78, 150, '#fff0b8', 0.7);
      rays(ctx, { x: CARD_W * 0.82, y: CARD_H * 0.78, count: 22, color: '#ffd700', seed: 149, alpha: 0.1 });
      // Climbing vines, the Secret Garden motif, lit gold on one side.
      vine(ctx, { x0: -30, y0: CARD_H + 20, x1: CARD_W * 0.5, y1: -30, bow: 150, color: '#1d5230', leaf: '#2f8c4c', seed: 151, width: 5 });
      vine(ctx, { x0: CARD_W + 30, y0: -20, x1: CARD_W * 0.42, y1: CARD_H + 30, bow: -120, color: '#22633a', leaf: '#43b268', seed: 157, width: 4 });
      vine(ctx, { x0: -20, y0: CARD_H * 0.15, x1: CARD_W * 0.75, y1: CARD_H + 40, bow: 90, color: '#2c7a46', leaf: '#ffd76a', seed: 163, width: 3 });
      // A thin sheen instead of a flat gold wash, so the art stays readable.
      ctx.save();
      const shine = ctx.createLinearGradient(0, CARD_H, CARD_W, 0);
      shine.addColorStop(0, rgba('#ffd700', 0));
      shine.addColorStop(0.55, rgba('#fff3b0', 0.22));
      shine.addColorStop(1, rgba('#ffd700', 0));
      ctx.fillStyle = shine;
      ctx.fillRect(0, 0, CARD_W, CARD_H);
      ctx.restore();
      sparkles(ctx, { count: 26, seed: 167 });
    },
  },
  {
    id: 'solarflare',
    name: 'Solar Flare',
    rarity: 'rare',
    draw(ctx) {
      linear(ctx, [[0, '#06040f'], [1, '#2a1a02']], { x1: 0, y1: CARD_H });
      stars(ctx, 180, 167, '#fff6d5', 2.4);
      const cx = CARD_W * 0.76;
      const cy = CARD_H * 0.42;
      rays(ctx, { x: cx, y: cy, count: 40, color: '#ffd700', seed: 173, alpha: 0.13 });
      glow(ctx, cx, cy, 300, '#ffb703', 0.7);
      glow(ctx, cx, cy, 120, '#fff8e0', 0.95);
      // Lens streak across the whole card.
      ctx.save();
      ctx.globalAlpha = 0.5;
      const streak = ctx.createLinearGradient(0, cy, CARD_W, cy);
      streak.addColorStop(0, rgba('#ffd700', 0));
      streak.addColorStop(0.5, rgba('#fff3b0', 0.8));
      streak.addColorStop(1, rgba('#ffd700', 0));
      ctx.fillStyle = streak;
      ctx.fillRect(0, cy - 4, CARD_W, 8);
      ctx.restore();
      sparkles(ctx, { count: 16, seed: 179 });
    },
  },
];

export const backgroundById = (id) => BACKGROUNDS.find((b) => b.id === id) ?? null;
export const DEFAULT_BACKGROUND = 'midnight';

/** Backgrounds of one rarity, in listing order. */
export const backgroundsOf = (rarity) => BACKGROUNDS.filter((b) => b.rarity === rarity);
