// Renders a sample card for every tier into ./card-previews so you can check the
// designs (and any color tweaks in config.json) without touching Discord.
//   npm run preview-cards
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderCard } from '../src/card/render.js';
import { ROOT_DIR, getConfig } from '../src/config.js';
import { progressFor, xpForRating } from '../src/rating.js';

const outDir = path.join(ROOT_DIR, 'card-previews');
fs.mkdirSync(outDir, { recursive: true });

// Stand-in avatar: a simple two-tone circle so the layout can be judged.
function fakeAvatar(hue) {
  const c = createCanvas(256, 256);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 256, 256);
  g.addColorStop(0, `hsl(${hue}, 70%, 60%)`);
  g.addColorStop(1, `hsl(${(hue + 60) % 360}, 70%, 35%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(128, 100, 48, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(128, 250, 90, 80, 0, 0, Math.PI * 2);
  ctx.fill();
  return c.toBuffer('image/png');
}

const cfg = getConfig();
const names = ['PackLuckPete', 'Weeezy', 'TacticsTom', 'SquadGoals', 'EliteEnjoyer', 'TheGOAT'];
const rendered = [];

for (const [i, tier] of cfg.tiers.entries()) {
  const next = cfg.tiers[i + 1];
  const rating = next ? Math.max(tier.minRating, next.minRating - 2) : tier.minRating;
  const floor = xpForRating(rating, cfg);
  const xp = rating >= cfg.rating.max ? floor : Math.round(floor + (xpForRating(rating + 1, cfg) - floor) * 0.6);
  const p = progressFor(xp, cfg);
  const png = await renderCard({
    name: names[i % names.length],
    avatar: fakeAvatar(i * 55),
    badge: null,
    rating: p.rating,
    tier,
    stats: [
      { label: 'XP', value: xp.toLocaleString('en-US') },
      { label: 'NXT', value: p.isMax ? 'MAX' : p.xpToNext.toLocaleString('en-US') },
      { label: 'RNK', value: `#${cfg.tiers.length - i}` },
      { label: 'RCT', value: String(Math.round(xp * 0.8)) },
      { label: 'FAN', value: String(Math.round(Math.sqrt(xp) * 3)) },
      { label: 'HOT', value: String(Math.round(xp * 0.25)) },
    ],
    progress: {
      fraction: p.fraction,
      text: p.isMax ? 'MAX RATING' : `${xp - p.floorXp} / ${p.nextXp - p.floorXp} XP TO ${p.nextRating}`,
    },
  });
  const file = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${tier.key}.png`);
  fs.writeFileSync(file, png);
  rendered.push(png);
  console.log(`wrote ${path.relative(ROOT_DIR, file)}  (${tier.name}, ${p.rating} OVR)`);
}

// All tiers side by side on a Discord-dark background.
const perRow = 3;
const sheet = createCanvas(600 * perRow, 860 * Math.ceil(rendered.length / perRow));
const ctx = sheet.getContext('2d');
ctx.fillStyle = '#313338';
ctx.fillRect(0, 0, sheet.width, sheet.height);
for (const [i, png] of rendered.entries()) {
  ctx.drawImage(await loadImage(png), (i % perRow) * 600, Math.floor(i / perRow) * 860);
}
const sheetFile = path.join(outDir, 'all-tiers.png');
fs.writeFileSync(sheetFile, sheet.toBuffer('image/png'));
console.log(`wrote ${path.relative(ROOT_DIR, sheetFile)}`);
