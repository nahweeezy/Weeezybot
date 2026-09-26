import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConfig } from '../src/config.js';
import { validateConfig } from '../src/configSchema.js';
import { buildThresholds, progressFor, ratingForXp, tierForRating, xpForRating } from '../src/rating.js';
import { fillTemplate } from '../src/util.js';

const cfg = getConfig();

test('everyone starts at the minimum rating', () => {
  assert.equal(ratingForXp(0), cfg.rating.min);
  assert.equal(xpForRating(cfg.rating.min), 0);
});

test('curve passes exactly through every configured anchor', () => {
  for (const a of cfg.rating.curve.anchors) {
    assert.equal(xpForRating(a.rating), a.xp, `rating ${a.rating}`);
    assert.equal(ratingForXp(a.xp), a.rating);
    if (a.xp > 0) assert.equal(ratingForXp(a.xp - 1), a.rating - 1);
  }
});

test('thresholds strictly increase and XP beyond the top stays at max', () => {
  const t = buildThresholds(cfg.rating);
  assert.equal(t.length, cfg.rating.max - cfg.rating.min + 1);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
  assert.equal(ratingForXp(10 ** 9), cfg.rating.max);
});

test('curve shape: fast to 75, slower 75-80, steeper after, brutal in the 90s', () => {
  const step = (r) => xpForRating(r) - xpForRating(r - 1);
  assert.ok(step(60) < 20);
  assert.ok(step(78) > step(70) * 5);
  assert.ok(step(83) > step(78));
  assert.ok(step(97) > step(83) * 5);
});

test('table-type curve is used verbatim', () => {
  const table = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [String(45 + i), i * 10]));
  const t = buildThresholds({ min: 45, max: 99, curve: { type: 'table', anchors: [], table } });
  assert.equal(t[0], 0);
  assert.equal(t.at(-1), 540);
});

test('progress toward the next rating', () => {
  const p = progressFor(xpForRating(80) + 10);
  assert.equal(p.rating, 80);
  assert.equal(p.nextRating, 81);
  assert.equal(p.xpToNext, xpForRating(81) - xpForRating(80) - 10);
  assert.equal(progressFor(xpForRating(99)).isMax, true);
});

test('tier boundaries match the spec', () => {
  const key = (r) => tierForRating(r).key;
  assert.equal(key(45), 'bronze');
  assert.equal(key(64), 'bronze');
  assert.equal(key(65), 'silver');
  assert.equal(key(74), 'silver');
  assert.equal(key(75), 'gold');
  assert.equal(key(84), 'gold');
  assert.equal(key(85), 'rare_gold');
  assert.equal(key(89), 'rare_gold');
  assert.equal(key(90), 'elite');
  assert.equal(key(98), 'elite');
  assert.equal(key(99), 'icon');
});

test('config validation rejects broken curves, tiers and typos', () => {
  const bad = (mutate) => {
    const draft = structuredClone(cfg);
    mutate(draft);
    assert.throws(() => validateConfig(draft));
  };
  assert.doesNotThrow(() => validateConfig(structuredClone(cfg)));
  bad((d) => (d.rating.curve.anchors[0].xp = 5)); // min rating must need 0 XP
  bad((d) => (d.rating.curve.anchors[2].xp = 100)); // not increasing
  bad((d) => (d.tiers[1].minRating = 40)); // tiers out of order
  bad((d) => (d.xp.pairCoolDownHours = 12)); // unknown key (typo)
  bad((d) => (d.rankup.channelId = 'general')); // not an ID
  bad((d) => (d.autothread.mediaLinkPatterns = ['(unclosed'])); // bad regex
});

test('message templates fill known placeholders only', () => {
  assert.equal(fillTemplate('{mention} upgraded to {newRating} OVR {x}', { mention: '@a', newRating: 76 }), '@a upgraded to 76 OVR {x}');
});
