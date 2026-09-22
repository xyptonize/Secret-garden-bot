// Rendering the profile card PNG: a background from cardArt.js, the member's
// avatar, their name and their SG-BOT stats.
//
// Everything is drawn at request time — nothing is stored but the background id,
// so a card always shows current stats and re-renders identically after a
// restart. If anything here fails, /sgprofile still answers with the plain
// embed: a card is decoration, never the payload.

import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { BACKGROUNDS, CARD_W, CARD_H, backgroundById, rarityOf, readability, DEFAULT_BACKGROUND } from './cardArt.js';

// DejaVu covers Latin and Cyrillic (Mongolian display names); the emoji font
// keeps 🎀 and friends from rendering as blanks. Both ship with the host.
const families = new Set(GlobalFonts.families.map((f) => f.family));
const BASE = families.has('DejaVu Sans') ? 'DejaVu Sans' : 'sans-serif';
const EMOJI = families.has('Noto Color Emoji') ? ', Noto Color Emoji' : '';
const FONT = (size, weight = '') => `${weight} ${size}px ${BASE}${EMOJI}`.trim();

const hexOf = (n) => `#${n.toString(16).padStart(6, '0')}`;

/** Fit `text` into `max` px, cutting with an ellipsis when it doesn't. */
function ellipsize(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > max) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The member's avatar, or null — a failed download must not fail the card. */
async function fetchAvatar(url) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      return await loadImage(Buffer.from(await res.arrayBuffer()));
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

function drawAvatar(ctx, image, { cx, cy, r, initial, ring }) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (image) {
    ctx.drawImage(image, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = '#2b2f36';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = '#e8e8e8';
    ctx.font = FONT(Math.round(r), 'bold');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, cx, cy);
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = ring;
  ctx.lineWidth = 5;
  ctx.shadowColor = ring;
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** One "LABEL / value" cell along the bottom of the card. */
function statCell(ctx, { x, y, w, label, value, color }) {
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
  roundRect(ctx, x, y, w, 70, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(235, 235, 240, 0.65)';
  ctx.font = FONT(14, 'bold');
  ctx.fillText(ellipsize(ctx, label.toUpperCase(), w - 24), x + 12, y + 26);
  ctx.fillStyle = color || '#ffffff';
  ctx.font = FONT(26, 'bold');
  ctx.fillText(ellipsize(ctx, String(value), w - 24), x + 12, y + 56);
  ctx.restore();
}

/**
 * The profile card.
 *
 * `card` = { background, name, subtitle, avatarUrl, stats: [{label, value}], tag }
 * Returns a PNG buffer.
 */
export async function renderCard({ background, name, subtitle, avatarUrl, stats = [], tag }) {
  const bg = backgroundById(background) || backgroundById(DEFAULT_BACKGROUND) || BACKGROUNDS[0];
  const rarity = rarityOf(bg.rarity);
  const accent = hexOf(rarity.color);

  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext('2d');
  bg.draw(ctx);
  readability(ctx);

  const image = await fetchAvatar(avatarUrl);
  drawAvatar(ctx, image, {
    cx: 112,
    cy: 112,
    r: 66,
    initial: (name || '?').trim().charAt(0).toUpperCase() || '?',
    ring: accent,
  });

  // Name, with a soft shadow so it reads over a bright background.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
  ctx.shadowBlur = 10;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = FONT(44, 'bold');
  ctx.fillText(ellipsize(ctx, name || 'Unknown', CARD_W - 230), 202, 106);
  if (subtitle) {
    ctx.fillStyle = 'rgba(232, 232, 240, 0.85)';
    ctx.font = FONT(22);
    ctx.fillText(ellipsize(ctx, subtitle, CARD_W - 230), 202, 142);
  }
  ctx.restore();

  // Stat cells: as many as fit, evenly across the bottom.
  const cells = stats.slice(0, 4);
  if (cells.length) {
    const left = 44;
    const right = CARD_W - 44;
    const gap = 14;
    const w = Math.floor((right - left - gap * (cells.length - 1)) / cells.length);
    cells.forEach((cell, i) => {
      statCell(ctx, { x: left + i * (w + gap), y: 206, w, label: cell.label, value: cell.value, color: cell.color });
    });
  }

  // Rarity frame + the background's own name, bottom right.
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, CARD_W - 6, CARD_H - 6);
  ctx.restore();

  ctx.save();
  ctx.textAlign = 'right';
  ctx.font = FONT(15, 'bold');
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = 8;
  ctx.fillStyle = accent;
  ctx.fillText(tag || `${bg.name} · ${rarity.name}`, CARD_W - 20, 192);
  ctx.restore();

  return canvas.toBuffer('image/png');
}

/** Just the artwork, titled — for unboxing reveals and previews. */
export function renderBackground(id, { title = true } = {}) {
  const bg = backgroundById(id) || BACKGROUNDS[0];
  const rarity = rarityOf(bg.rarity);
  const accent = hexOf(rarity.color);
  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext('2d');
  bg.draw(ctx);

  if (title) {
    ctx.save();
    const strip = ctx.createLinearGradient(0, CARD_H - 110, 0, CARD_H);
    strip.addColorStop(0, 'rgba(0, 0, 0, 0)');
    strip.addColorStop(1, 'rgba(0, 0, 0, 0.8)');
    ctx.fillStyle = strip;
    ctx.fillRect(0, CARD_H - 110, CARD_W, 110);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = FONT(40, 'bold');
    ctx.fillText(ellipsize(ctx, bg.name, CARD_W - 60), CARD_W / 2, CARD_H - 48);
    ctx.fillStyle = accent;
    ctx.font = FONT(20, 'bold');
    ctx.fillText(rarity.name.toUpperCase(), CARD_W / 2, CARD_H - 20);
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, CARD_W - 6, CARD_H - 6);
  ctx.restore();
  return canvas.toBuffer('image/png');
}

/**
 * The whole collection as one sheet: owned in colour, missing dimmed — like a
 * CS2 case listing, where you can see everything you haven't pulled yet.
 */
export function renderCollection(owned = {}) {
  const COLS = 4;
  const TW = 228;
  const TH = 76;
  const PAD = 12;
  const LABEL = 22;
  const rows = Math.ceil(BACKGROUNDS.length / COLS);
  const canvas = createCanvas(COLS * (TW + PAD) + PAD, rows * (TH + LABEL + PAD) + PAD);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1b1d23';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  BACKGROUNDS.forEach((bg, i) => {
    const x = PAD + (i % COLS) * (TW + PAD);
    const y = PAD + Math.floor(i / COLS) * (TH + LABEL + PAD);
    const count = owned[bg.id] || 0;
    const tile = createCanvas(CARD_W, CARD_H);
    bg.draw(tile.getContext('2d'));

    ctx.save();
    if (!count) ctx.globalAlpha = 0.25;
    ctx.drawImage(tile, x, y, TW, TH);
    ctx.restore();

    const rarity = rarityOf(bg.rarity);
    ctx.save();
    ctx.globalAlpha = count ? 1 : 0.3; // the tier is still readable when locked
    ctx.fillStyle = hexOf(rarity.color);
    ctx.fillRect(x, y + TH, TW, 3);
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.fillStyle = count ? '#e9e9ee' : 'rgba(233, 233, 238, 0.38)';
    ctx.font = FONT(13, count ? 'bold' : '');
    ctx.fillText(ellipsize(ctx, `${count ? '' : '🔒 '}${bg.name}`, TW - 34), x + 2, y + TH + LABEL - 3);
    if (count > 1) {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(233, 233, 238, 0.6)';
      ctx.font = FONT(13);
      ctx.fillText(`×${count}`, x + TW, y + TH + LABEL - 3);
    }
  });
  return canvas.toBuffer('image/png');
}
