import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { closeDb, getRecentEvents, getUser } from '../src/db.js';
import { handleMessageXp } from '../src/messageXp.js';

process.env.DATABASE_PATH = ':memory:';
process.env.GUILD_ID = '900000000000000001';
beforeEach(() => closeDb());

let n = 0;
const guild = { members: { fetch: async () => null } };
const message = (authorId, extra = {}) => ({
  id: `m${++n}`, type: 0, guild, guildId: '900000000000000001', channelId: '900000000000000099',
  inGuild: () => true, author: { id: authorId, bot: false, username: authorId }, webhookId: null, system: false,
  attachments: { some: () => false }, embeds: [], content: 'gg', ...extra,
});
const lucky = { random: () => 0.1 };
const unlucky = { random: () => 0.9 };

test('a lucky roll (25%) gives 1 XP, an unlucky one gives nothing', async () => {
  assert.equal(await handleMessageXp(message('A'), unlucky), null);
  assert.equal(getUser('A'), null);
  await handleMessageXp(message('A'), lucky);
  assert.equal(getUser('A').xp, 1);
  assert.equal(getRecentEvents('A', 1)[0].kind, 'message');
});

test('at most 1 message XP per hour', async () => {
  await handleMessageXp(message('A'), lucky);
  for (let i = 0; i < 20; i++) await handleMessageXp(message('A'), lucky);
  assert.equal(getUser('A').xp, 1);
});

test('an unlucky roll does not start the cooldown', async () => {
  await handleMessageXp(message('A'), unlucky);
  await handleMessageXp(message('A'), lucky);
  assert.equal(getUser('A').xp, 1);
});

test('bots and other servers never get message XP', async () => {
  assert.equal(await handleMessageXp(message('B', { author: { id: 'B', bot: true } }), lucky), null);
  assert.equal(await handleMessageXp(message('C', { guildId: '123' }), lucky), null);
});
