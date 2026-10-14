import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';

// Own config copy with bonus channels set (never touches the repo's config.json).
const TACTICS = '900000000000000011';
const PACK_LUCK = '900000000000000022';
const CATEGORY = '900000000000000033';
const cfg = JSON.parse(fs.readFileSync(new URL('../config.defaults.json', import.meta.url), 'utf8'));
cfg.postBonus = {
  [TACTICS]: { xp: 10, cooldownHours: 12, requires: 'any' },
  [PACK_LUCK]: { xp: 5, cooldownHours: 1, requires: 'media' },
};
cfg.channelMultipliers = { [TACTICS]: 2, [CATEGORY]: 3 };
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-')), 'config.json');
fs.writeFileSync(file, JSON.stringify(cfg));
process.env.CONFIG_PATH = file;
process.env.DATABASE_PATH = ':memory:';

const { channelMultiplier, grantPostBonus, postBonusFor } = await import('../src/channelBonuses.js');
const db = await import('../src/db.js');
beforeEach(() => db.closeDb());

const HOUR = 3600000;
const T0 = Date.UTC(2026, 9, 1);
const media = { attachments: { some: (f) => f({ contentType: 'image/png' }) }, embeds: [], content: '' };
const text = { attachments: { some: () => false }, embeds: [], content: 'hi' };
const thread = (id, parentId) => ({ id, parentId, isThread: () => true, parent: { parentId: null } });

test('multiplier: own channel, then parent (threads/forum posts), then category', () => {
  assert.equal(channelMultiplier({ id: TACTICS }), 2);
  assert.equal(channelMultiplier(thread('post1', TACTICS)), 2);
  assert.equal(channelMultiplier({ id: 'x', parentId: CATEGORY }), 3);
  assert.equal(channelMultiplier({ id: 'other' }), 1);
});

test('tactics forum: a new post counts, replies inside it do not', () => {
  const post = thread('900000000000000501', TACTICS);
  assert.equal(postBonusFor({ id: post.id, channelId: post.id, ...text }, post).xp, 10);
  assert.equal(postBonusFor({ id: '900000000000000502', channelId: post.id, ...text }, post), null);
});

test('pack luck: needs a picture/video', () => {
  const channel = { id: PACK_LUCK, isThread: () => false };
  assert.equal(postBonusFor({ id: 'a', channelId: PACK_LUCK, ...text }, channel), null);
  assert.equal(postBonusFor({ id: 'b', channelId: PACK_LUCK, ...media }, channel).xp, 5);
});

test('post bonus cooldowns are per channel and per member', () => {
  const channel = { id: PACK_LUCK, isThread: () => false };
  const msg = (id) => ({ id, channelId: PACK_LUCK, author: { id: 'A', username: 'a' }, ...media });
  const bonus = postBonusFor(msg('1'), channel);
  assert.ok(grantPostBonus(msg('1'), bonus, T0));
  assert.equal(grantPostBonus(msg('2'), bonus, T0 + HOUR - 1), null); // within the hour
  assert.ok(grantPostBonus(msg('3'), bonus, T0 + HOUR));
  const post = thread('900000000000000601', TACTICS);
  const tactic = { id: post.id, channelId: post.id, author: { id: 'A', username: 'a' }, ...text };
  assert.ok(grantPostBonus(tactic, postBonusFor(tactic, post), T0)); // separate cooldown from pack luck
  assert.equal(db.getUser('A').xp, 20);
  assert.equal(db.getRecentEvents('A', 1)[0].kind, 'post_bonus');
});
