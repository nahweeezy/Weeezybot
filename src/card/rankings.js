// Draws the /ranks image: the server's top players as a table styled like the player cards
// (same font, same shield shape and tier colors for the rating badges).
import { createCanvas } from '@napi-rs/canvas';
import { drawCircleImage, fitText, font, hexToRgba, shieldPath, tryLoad } from './render.js';

const W = 1100;
const HEADER = 230;
const ROW_H = 84;
const ROW_GAP = 10;
const FOOTER = 64;
const GOLD = '#F3D57A';
const MUTED = '#9a9cab';
const MEDALS = ['#F3D57A', '#D7DEE5', '#E0A46E'];
const STAT_COLUMNS = [
  { key: 'xp', label: 'XP', x: 690 },
  { key: 'reactions', label: 'RCT', x: 810 },
  { key: 'fans', label: 'FAN', x: 915 },
  { key: 'hot', label: 'HOT', x: 1015 },
];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawBackground(ctx, h) {
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#1d2029');
  bg.addColorStop(1, '#0b0c10');
  roundRect(ctx, 0, 0, W, h, 28);
  ctx.fillStyle = bg;
  ctx.fill();

  // Gold sunburst behind the header, like the special cards.
  ctx.save();
  roundRect(ctx, 0, 0, W, h, 28);
  ctx.clip();
  const cx = W / 2;
  const cy = -40;
  ctx.fillStyle = hexToRgba(GOLD, 0.05);
  for (let i = 0; i < 36; i += 2) {
    const a1 = (i / 36) * Math.PI * 2;
    const a2 = ((i + 1) / 36) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a1) * 1600, cy + Math.sin(a1) * 1600);
    ctx.lineTo(cx + Math.cos(a2) * 1600, cy + Math.sin(a2) * 1600);
    ctx.closePath();
    ctx.fill();
  }
  const glow = ctx.createRadialGradient(cx, 0, 10, cx, 0, 520);
  glow.addColorStop(0, hexToRgba(GOLD, 0.22));
  glow.addColorStop(1, hexToRgba(GOLD, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, HEADER + 100);
  ctx.restore();

  roundRect(ctx, 3, 3, W - 6, h - 6, 26);
  ctx.lineWidth = 4;
  ctx.strokeStyle = hexToRgba(GOLD, 0.9);
  ctx.stroke();
  roundRect(ctx, 14, 14, W - 28, h - 28, 20);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = hexToRgba(GOLD, 0.35);
  ctx.stroke();
}

/** Mini rating card: the tier's card colors in the FC shield shape. */
function drawRatingBadge(ctx, x, y, rating, tier) {
  const w = 56;
  const h = 72;
  const style = tier.card;
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  style.background.forEach((c, i) => g.addColorStop(style.background.length === 1 ? 0 : i / (style.background.length - 1), c));
  shieldPath(ctx, x, y, w, h);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = style.border;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = style.text;
  ctx.font = font(800, 30);
  ctx.fillText(String(rating), x + w / 2, y + 38);
  ctx.font = font(700, 13);
  ctx.fillText('OVR', x + w / 2, y + 54);
}

/**
 * @param {object} data
 * @param {string} data.serverName
 * @param {Buffer|null} data.badge    server icon
 * @param {string} data.subtitle      e.g. the date
 * @param {{position, name, rating, tier, avatar, stats: {xp, reactions, fans, hot}}[]} data.rows
 * @returns {Promise<Buffer>} PNG
 */
export async function renderRankings({ serverName, badge, subtitle, rows }) {
  const h = HEADER + rows.length * (ROW_H + ROW_GAP) + FOOTER;
  const canvas = createCanvas(W, h);
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, h);

  // Header: server badge, title, server name, date.
  const badgeImg = await tryLoad(badge);
  let titleX = 60;
  if (badgeImg) {
    drawCircleImage(ctx, badgeImg, 100, 100, 46);
    ctx.beginPath();
    ctx.arc(100, 100, 46, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = GOLD;
    ctx.stroke();
    titleX = 170;
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = GOLD;
  ctx.font = font(800, 84);
  ctx.fillText(`TOP ${rows.length}`, titleX, 118);
  ctx.fillStyle = '#e8e8ee';
  fitText(ctx, serverName.toUpperCase(), 700, 30, 560);
  ctx.fillText(serverName.toUpperCase(), titleX, 158);
  ctx.textAlign = 'right';
  ctx.fillStyle = MUTED;
  ctx.font = font(600, 24);
  ctx.fillText(subtitle.toUpperCase(), W - 50, 70);

  // Column labels.
  const labelY = HEADER - 14;
  ctx.font = font(700, 20);
  ctx.fillStyle = MUTED;
  ctx.textAlign = 'center';
  ctx.fillText('#', 75, labelY);
  ctx.fillText('OVR', 146, labelY);
  ctx.textAlign = 'left';
  ctx.fillText('PLAYER', 270, labelY);
  ctx.textAlign = 'center';
  for (const col of STAT_COLUMNS) ctx.fillText(col.label, col.x, labelY);

  const avatars = await Promise.all(rows.map((r) => tryLoad(r.avatar)));

  rows.forEach((row, i) => {
    const y = HEADER + i * (ROW_H + ROW_GAP);
    const cy = y + ROW_H / 2;
    const { tier } = row;

    // Row panel, tinted with the tier's card colors, with a tier-colored edge.
    const tint = ctx.createLinearGradient(30, y, W - 30, y);
    tint.addColorStop(0, hexToRgba(tier.card.background[Math.floor(tier.card.background.length / 2)], 0.32));
    tint.addColorStop(0.45, 'rgba(255,255,255,0.04)');
    tint.addColorStop(1, 'rgba(255,255,255,0.03)');
    roundRect(ctx, 30, y, W - 60, ROW_H, 16);
    ctx.fillStyle = '#16181f';
    ctx.fill();
    ctx.fillStyle = tint;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = hexToRgba(tier.color, row.position <= 3 ? 0.7 : 0.25);
    ctx.stroke();
    roundRect(ctx, 30, y, 8, ROW_H, 4);
    ctx.fillStyle = tier.color;
    ctx.fill();

    // Position.
    ctx.textAlign = 'center';
    ctx.fillStyle = MEDALS[row.position - 1] ?? '#e6e6ea';
    ctx.font = font(800, 44);
    ctx.fillText(String(row.position), 75, cy + 15);

    drawRatingBadge(ctx, 118, y + 6, row.rating, tier);

    // Avatar.
    const ax = 222;
    if (avatars[i]) drawCircleImage(ctx, avatars[i], ax, cy, 30);
    else {
      ctx.beginPath();
      ctx.arc(ax, cy, 30, 0, Math.PI * 2);
      ctx.fillStyle = '#2a2d38';
      ctx.fill();
      ctx.fillStyle = '#e6e6ea';
      ctx.font = font(800, 30);
      ctx.fillText((row.name[0] ?? '?').toUpperCase(), ax, cy + 11);
    }
    ctx.beginPath();
    ctx.arc(ax, cy, 31, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = tier.color;
    ctx.stroke();

    // Name + tier.
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    const name = row.name.toUpperCase();
    fitText(ctx, name, 800, 34, 330, 20);
    ctx.fillText(name, 270, cy + 2);
    ctx.fillStyle = tier.color;
    ctx.font = font(700, 20);
    ctx.fillText(tier.name.toUpperCase(), 270, cy + 28);

    // Stats.
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    for (const col of STAT_COLUMNS) {
      fitText(ctx, row.stats[col.key], 800, 32, 104, 18);
      ctx.fillText(row.stats[col.key], col.x, cy + 11);
    }
  });

  // Legend.
  ctx.textAlign = 'center';
  ctx.fillStyle = MUTED;
  ctx.font = font(600, 20);
  ctx.fillText('XP TOTAL XP  ·  RCT REACTIONS RECEIVED  ·  FAN UNIQUE REACTORS  ·  HOT FIRE REACTIONS', W / 2, h - 30);

  return canvas.encode('png');
}
