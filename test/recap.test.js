import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { closeDb, getTopMessages, pruneMessageReactions, recordMessageReaction, removeMessageReactions } from '../src/db.js';

process.env.DATABASE_PATH = ':memory:';
beforeEach(() => closeDb());

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 18);
const react = (messageId, userId, emoji, { author = 'A', postedDaysAgo = 1 } = {}) =>
  recordMessageReaction({
    messageId, userId, emoji, emojiDisplay: emoji, channelId: 'c', authorId: author,
    messageCreatedAt: NOW - postedDaysAgo * DAY, now: NOW,
  });

test('ranks posts by reactions, lists reactors and an emoji breakdown', () => {
  react('m1', 'u1', '🔥'); react('m1', 'u2', '🔥'); react('m1', 'u2', '😂');
  react('m2', 'u1', '🔥', { author: 'B' });
  const [top, second] = getTopMessages(NOW - 7 * DAY, 5);
  assert.equal(top.message_id, 'm1');
  assert.equal(top.total, 3);
  assert.equal(top.people, 2);
  assert.deepEqual(top.reactors, ['u1', 'u2']);
  assert.deepEqual(top.emojis.map((e) => [e.emoji_display, e.n]), [['🔥', 2], ['😂', 1]]);
  assert.equal(second.author_id, 'B');
});

test('only posts from the lookback window count', () => {
  react('old', 'u1', '🔥', { postedDaysAgo: 9 });
  react('new', 'u1', '🔥', { postedDaysAgo: 2 });
  assert.deepEqual(getTopMessages(NOW - 7 * DAY, 5).map((r) => r.message_id), ['new']);
});

test('re-adding the same reaction is not double counted; removals are forgotten', () => {
  react('m1', 'u1', '🔥'); react('m1', 'u1', '🔥'); react('m1', 'u2', '👍'); react('m1', 'u3', '👍');
  assert.equal(getTopMessages(0, 1)[0].total, 3);
  removeMessageReactions('m1', { userId: 'u1', emoji: '🔥' });
  assert.equal(getTopMessages(0, 1)[0].total, 2);
  removeMessageReactions('m1', { emoji: '👍' });
  assert.equal(getTopMessages(0, 1).length, 0);
});

test('old rows are pruned', () => {
  react('old', 'u1', '🔥', { postedDaysAgo: 40 });
  assert.equal(pruneMessageReactions(NOW - 31 * DAY), 1);
});
