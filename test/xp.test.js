import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { closeDb, adjustXp, getProfile, getRecentEvents, getUser, pickBestCandidate, recordReactionSeen, tryReactionGrant } from '../src/db.js';
import { emojiXpValue, normalizeEmoji } from '../src/emoji.js';

// Fresh in-memory database for every test.
process.env.DATABASE_PATH = ':memory:';
beforeEach(() => closeDb());

const HOUR = 60 * 60 * 1000;
const RULES = { cooldownMs: 24 * HOUR, oncePerMessage: true };
const T0 = Date.UTC(2026, 0, 1);

let seq = 0;
function reaction(giverId, receiverId, messageId, emoji, amount, receivedAt = T0 + seq++) {
  return { giverId, receiverId, messageId, channelId: 'c1', emojiDisplay: emoji, amount, receivedAt };
}
const grant = (candidates, now) => tryReactionGrant(candidates, { ...RULES, now });

test('🔥 is worth 3, everything else 1 (and ❤️ with/without variation selector match)', () => {
  assert.equal(emojiXpValue({ name: '🔥' }), 3);
  assert.equal(emojiXpValue({ name: '👍' }), 1);
  assert.equal(emojiXpValue({ id: '123456789012345678', name: 'pog' }), 1);
  assert.equal(normalizeEmoji('❤️'), normalizeEmoji('❤'));
  assert.equal(normalizeEmoji('<:pog:123456789012345678>'), '123456789012345678');
});

test('many different people each grant XP', () => {
  for (let i = 0; i < 100; i++) assert.ok(grant([reaction(`giver${i}`, 'me', 'm1', '🔥', 3)], T0));
  assert.equal(getUser('me').xp, 300);
});

test('same person reacting to 10 posts in a day only grants once', () => {
  for (let i = 0; i < 10; i++) grant([reaction('A', 'B', `m${i}`, '👍', 1)], T0 + i * HOUR);
  assert.equal(getUser('B').xp, 1);
});

test('the lock is a rolling window and survives until it expires', () => {
  assert.ok(grant([reaction('A', 'B', 'm1', '👍', 1)], T0));
  assert.equal(grant([reaction('A', 'B', 'm2', '👍', 1)], T0 + 24 * HOUR - 1), null);
  assert.ok(grant([reaction('A', 'B', 'm3', '👍', 1)], T0 + 24 * HOUR));
  assert.equal(getUser('B').xp, 2);
});

test('the lock is per direction: B can still grant A', () => {
  assert.ok(grant([reaction('A', 'B', 'm1', '🔥', 3)], T0));
  assert.ok(grant([reaction('B', 'A', 'm2', '🔥', 3)], T0));
});

test('emojis added at the same time: highest value wins, only one grant', () => {
  const r = grant([reaction('A', 'B', 'm1', '👍', 1), reaction('A', 'B', 'm1', '🔥', 3), reaction('A', 'B', 'm1', '😂', 1)], T0);
  assert.equal(r.grant.emojiDisplay, '🔥');
  assert.equal(getUser('B').xp, 3);
  assert.equal(getRecentEvents('B', 10).length, 1);
});

test('equal values: the first reaction wins', () => {
  const best = pickBestCandidate([reaction('A', 'B', 'm1', '😂', 1, 20), reaction('A', 'B', 'm1', '👍', 1, 10)]);
  assert.equal(best.emojiDisplay, '👍');
});

test('a later 🔥 does not upgrade an earlier 👍 grant', () => {
  grant([reaction('A', 'B', 'm1', '👍', 1)], T0);
  assert.equal(grant([reaction('A', 'B', 'm1', '🔥', 3)], T0 + 5000), null);
  assert.equal(getUser('B').xp, 1);
});

test('re-reacting on the same message never grants twice (oncePerMessage), even after the window', () => {
  grant([reaction('A', 'B', 'm1', '🔥', 3)], T0);
  assert.equal(grant([reaction('A', 'B', 'm1', '🔥', 3)], T0 + 48 * HOUR), null);
  // ...but a different message after the window does.
  assert.ok(grant([reaction('A', 'B', 'm2', '🔥', 3)], T0 + 48 * HOUR));
});

test('0-XP emojis grant nothing and do not use up the lock', () => {
  assert.equal(grant([reaction('A', 'B', 'm1', '👎', 0)], T0), null);
  assert.ok(grant([reaction('A', 'B', 'm2', '👍', 1)], T0 + 1000));
});

test('every grant is logged with giver, receiver, message, channel, emoji, amount, time', () => {
  grant([reaction('A', 'B', 'm1', '🔥', 3)], T0);
  const [e] = getRecentEvents('B', 1);
  assert.deepEqual(
    { kind: e.kind, giver: e.giver_id, receiver: e.receiver_id, msg: e.message_id, ch: e.channel_id, emoji: e.emoji, amount: e.amount, at: e.created_at },
    { kind: 'reaction', giver: 'A', receiver: 'B', msg: 'm1', ch: 'c1', emoji: '🔥', amount: 3, at: T0 },
  );
});

test('rating changes are reported so rank-ups can be announced', () => {
  const r = grant([reaction('A', 'B', 'm1', '🔥', 3)], T0);
  assert.equal(r.oldRating, 45);
  assert.equal(r.newRating, 46); // 3 XP: past 46 (1 XP), short of 47 (4 XP)
});

test('admin add/remove/set/reset adjust XP, never go below 0, and are logged', () => {
  adjustXp({ receiverId: 'B', giverId: 'admin', kind: 'admin_add', delta: 500 });
  assert.equal(getUser('B').xp, 500);
  adjustXp({ receiverId: 'B', giverId: 'admin', kind: 'admin_remove', delta: -9999 });
  assert.equal(getUser('B').xp, 0);
  const set = adjustXp({ receiverId: 'B', giverId: 'admin', kind: 'admin_set', set: 1000 });
  assert.equal(set.newRating, 80);
  adjustXp({ receiverId: 'B', giverId: 'admin', kind: 'admin_reset', set: 0, reason: 'test' });
  assert.equal(getUser('B').rating, 45);
  assert.equal(getRecentEvents('B', 10).length, 4);
});

test('card stats count reactions, unique reactors and 🔥 without double counting re-reacts', () => {
  const seen = (giverId, messageId, emojiKey) => recordReactionSeen({ messageId, giverId, emojiKey, receiverId: 'B', channelId: 'c1', now: T0 });
  seen('A', 'm1', '🔥');
  seen('A', 'm1', '🔥'); // removed and re-added
  seen('A', 'm1', '👍');
  seen('C', 'm2', '🔥');
  const p = getProfile('B');
  assert.equal(p.reactionsReceived, 3);
  assert.equal(p.uniqueReactors, 2);
  assert.equal(p.hotReactions, 2);
});

test('leaderboard rank', () => {
  adjustXp({ receiverId: 'X', kind: 'admin_add', delta: 100, now: T0 });
  adjustXp({ receiverId: 'Y', kind: 'admin_add', delta: 300, now: T0 });
  adjustXp({ receiverId: 'Z', kind: 'admin_add', delta: 100, now: T0 + 1 });
  assert.equal(getProfile('Y').rank, 1);
  assert.equal(getProfile('X').rank, 2); // reached 100 first
  assert.equal(getProfile('Z').rank, 3);
  assert.equal(getProfile('nobody').rank, null);
});
