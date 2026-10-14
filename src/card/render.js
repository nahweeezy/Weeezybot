// Draws the FC-style player card PNG. Pure drawing: takes plain data, returns a PNG buffer.
// Colors and the background pattern come from the tier's `card` block in config.json.
import path from 'node:path';
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import { ROOT_DIR } from '../config.js';

const FONT = 'CardCondensed';
for (const file of ['BarlowCondensed_600SemiBold.ttf', 'BarlowCondensed_700Bold.ttf', 'BarlowCondensed_800ExtraBold.ttf']) {
  GlobalFonts.registerFromPath(path.join(ROOT_DIR, 'assets', 'fonts', file), FONT);
}

const W = 600;
const H = 860;
const CARD = { x: 20, y: 20, w: 560, h: 820 };

/** The classic FC card outline: notched top corners, straight sides, tapered bottom. */
export function shieldPath(ctx, x, y, w, h) {
  const notch = w * 0.1;
  ctx.beginPath();
  ctx.moveTo(x + notch, y);
  ctx.lineTo(x + w - notch, y);
  ctx.quadraticCurveTo(x + w - notch, y + notch, x + w, y + notch);
  ctx.lineTo(x + w, y + h * 0.8);
  ctx.bezierCurveTo(x + w, y + h * 0.9, x + w * 0.64, y + h * 0.93, x + w / 2, y + h);
  ctx.bezierCurveTo(x + w * 0.36, y + h * 0.93, x, y + h * 0.9, x, y + h * 0.8);
  ctx.lineTo(x, y + notch);
  ctx.quadraticCurveTo(x + notch, y + notch, x + notch, y);
  ctx.closePath();
}

export function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function font(weight, size) {
  return `${weight} ${size}px ${FONT}, sans-serif`;
}

/** Shrink the font until the text fits maxWidth. */
export function fitText(ctx, text, weight, size, maxWidth, minSize = 18) {
  let s = size;
  ctx.font = font(weight, s);
  while (s > minSize && ctx.measureText(text).width > maxWidth) {
    s -= 2;
    ctx.font = font(weight, s);
  }
}

function drawShine(ctx) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.3, 'rgba(255,255,255,0)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.32)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.05)');
  g.addColorStop(0.58, 'rgba(255,255,255,0.22)');
  g.addColorStop(0.66, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

export function drawRays(ctx, color) {
  const cx = W * 0.62;
  const cy = H * 0.27;
  const count = 28;
  const radius = Math.hypot(W, H);
  ctx.fillStyle = hexToRgba(color, 0.13);
  for (let i = 0; i < count; i += 2) {
    const a1 = (i / count) * Math.PI * 2;
    const a2 = ((i + 1) / count) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius);
    ctx.lineTo(cx + Math.cos(a2) * radius, cy + Math.sin(a2) * radius);
    ctx.closePath();
    ctx.fill();
  }
  const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, 320);
  glow.addColorStop(0, hexToRgba(color, 0.35));
  glow.addColorStop(1, hexToRgba(color, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function drawHolo(ctx) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  const hues = ['#ff9ad5', '#ffd36e', '#8bffb0', '#7fd8ff', '#b99bff', '#ff9ad5'];
  hues.forEach((c, i) => g.addColorStop(i / (hues.length - 1), c));
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

export function drawCircleImage(ctx, image, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(image, cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

export async function tryLoad(buffer) {
  if (!buffer) return null;
  try {
    return await loadImage(buffer);
  } catch {
    return null;
  }
}

/**
 * @param {object} data
 * @param {string} data.name         Display name (emoji are stripped; the font has none).
 * @param {Buffer|null} data.avatar  Avatar image bytes.
 * @param {Buffer|null} data.badge   Server icon bytes (drawn like a club badge).
 * @param {number} data.rating
 * @param {object} data.tier         Tier object from config (uses name + card colors).
 * @param {{label: string, value: string}[]} data.stats  Six stats, drawn in two columns.
 * @param {{fraction: number, text: string}} data.progress
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function renderCard({ name, avatar, badge, rating, tier, stats, progress }) {
  const style = tier.card;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const { x, y, w, h } = CARD;

  // Card body with a soft drop shadow.
  const bg = ctx.createLinearGradient(x, y, x + w * 0.6, y + h);
  style.background.forEach((c, i) => bg.addColorStop(style.background.length === 1 ? 0 : i / (style.background.length - 1), c));
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 8;
  shieldPath(ctx, x, y, w, h);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.restore();

  // Tier pattern, clipped to the card.
  ctx.save();
  shieldPath(ctx, x, y, w, h);
  ctx.clip();
  if (style.pattern === 'rays' || style.pattern === 'holo') drawRays(ctx, style.accent);
  if (style.pattern === 'holo') drawHolo(ctx);
  if (style.pattern !== 'none') drawShine(ctx);
  ctx.restore();

  // Outer edge + inner frame line.
  shieldPath(ctx, x, y, w, h);
  ctx.lineWidth = 6;
  ctx.strokeStyle = style.border;
  ctx.stroke();
  shieldPath(ctx, x + 16, y + 16, w - 32, h - 32);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = hexToRgba(style.accent, 0.85);
  ctx.stroke();

  ctx.fillStyle = style.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // Left column: rating, OVR, tier, server badge.
  const colX = 134;
  ctx.font = font(800, 132);
  ctx.fillText(String(rating), colX, 208);
  ctx.font = font(700, 40);
  ctx.fillText('OVR', colX, 252);
  ctx.fillStyle = hexToRgba(style.text, 0.45);
  ctx.fillRect(colX - 42, 270, 84, 3);
  ctx.fillStyle = style.text;
  fitText(ctx, tier.name.toUpperCase(), 700, 28, 120);
  ctx.fillText(tier.name.toUpperCase(), colX, 308);
  ctx.fillStyle = hexToRgba(style.text, 0.45);
  ctx.fillRect(colX - 42, 324, 84, 3);

  const badgeImg = await tryLoad(badge);
  if (badgeImg) {
    drawCircleImage(ctx, badgeImg, colX, 374, 32);
    ctx.beginPath();
    ctx.arc(colX, 374, 32, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = hexToRgba(style.text, 0.5);
    ctx.stroke();
  }

  // Avatar ("player photo").
  const av = { cx: 384, cy: 248, r: 134 };
  const avatarImg = await tryLoad(avatar);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.arc(av.cx, av.cy, av.r + 6, 0, Math.PI * 2);
  ctx.fillStyle = style.accent;
  ctx.fill();
  ctx.restore();
  if (avatarImg) drawCircleImage(ctx, avatarImg, av.cx, av.cy, av.r);
  else {
    ctx.beginPath();
    ctx.arc(av.cx, av.cy, av.r, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(style.text, 0.2);
    ctx.fill();
    ctx.fillStyle = style.text;
    ctx.font = font(800, 120);
    ctx.fillText((name[0] ?? '?').toUpperCase(), av.cx, av.cy + 42);
  }
  ctx.beginPath();
  ctx.arc(av.cx, av.cy, av.r + 6, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = style.border;
  ctx.stroke();

  // Name.
  ctx.fillStyle = style.text;
  const displayName = name.toUpperCase();
  fitText(ctx, displayName, 800, 60, 460, 26);
  ctx.fillText(displayName, W / 2, 462);
  ctx.fillStyle = hexToRgba(style.text, 0.45);
  ctx.fillRect(110, 482, W - 220, 3);

  // Stats: two columns of three, "value LABEL" like FC's "92 PAC".
  ctx.fillRect(W / 2 - 1.5, 505, 3, 160);
  const columns = [W / 2 - 110, W / 2 + 110];
  stats.slice(0, 6).forEach((stat, i) => {
    const cx = columns[Math.floor(i / 3)];
    const baseline = 545 + (i % 3) * 56;
    ctx.fillStyle = style.text;
    ctx.textAlign = 'right';
    fitText(ctx, stat.value, 800, 44, 110, 24);
    ctx.fillText(stat.value, cx + 14, baseline);
    ctx.textAlign = 'left';
    ctx.font = font(600, 34);
    ctx.fillStyle = hexToRgba(style.text, 0.85);
    ctx.fillText(stat.label, cx + 24, baseline);
  });

  // Progress to the next rating.
  const bar = { x: 120, y: 694, w: W - 240, h: 14 };
  ctx.beginPath();
  ctx.roundRect(bar.x, bar.y, bar.w, bar.h, bar.h / 2);
  ctx.fillStyle = hexToRgba(style.text, 0.2);
  ctx.fill();
  const filled = Math.max(bar.h, bar.w * Math.min(1, Math.max(0, progress.fraction)));
  ctx.beginPath();
  ctx.roundRect(bar.x, bar.y, filled, bar.h, bar.h / 2);
  ctx.fillStyle = style.text;
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.fillStyle = style.text;
  fitText(ctx, progress.text, 600, 26, 400, 16);
  ctx.fillText(progress.text, W / 2, 742);

  // Small diamond near the tip.
  ctx.save();
  ctx.translate(W / 2, 790);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = hexToRgba(style.text, 0.55);
  ctx.fillRect(-7, -7, 14, 14);
  ctx.restore();

  return canvas.encode('png');
}
