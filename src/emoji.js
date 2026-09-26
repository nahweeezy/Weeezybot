// Helpers for turning Discord reaction emojis into stable keys and XP values.
import { getConfig } from './config.js';

const CUSTOM_EMOJI_RE = /^<a?:(\w+):(\d{17,20})>$/;

/** Strip the invisible variation selector so "❤️" and "❤" count as the same emoji. */
export function normalizeEmoji(text) {
  const trimmed = String(text).trim();
  const custom = trimmed.match(CUSTOM_EMOJI_RE);
  if (custom) return custom[2];
  return trimmed.replace(/️/g, '');
}

/** Stable key for a reaction emoji: the ID for custom emojis, the character itself for unicode. */
export function emojiKey(emoji) {
  return emoji.id ?? normalizeEmoji(emoji.name ?? '');
}

/** Human-readable form for logs and messages. */
export function emojiDisplay(emoji) {
  return emoji.id ? `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>` : emoji.name;
}

let cache = { source: null, map: null };

/**
 * XP a reaction is worth. config.xp.emojiValues keys may be a unicode emoji, a custom
 * emoji ID, a custom emoji name, or the full <:name:id> form; anything else is worth defaultEmojiXp.
 */
export function emojiXpValue(emoji, cfg = getConfig()) {
  if (cache.source !== cfg.xp.emojiValues) {
    const map = new Map();
    for (const [key, value] of Object.entries(cfg.xp.emojiValues)) map.set(normalizeEmoji(key), value);
    cache = { source: cfg.xp.emojiValues, map };
  }
  const { map } = cache;
  if (emoji.id && map.has(emoji.id)) return map.get(emoji.id);
  const name = normalizeEmoji(emoji.name ?? '');
  if (map.has(name)) return map.get(name);
  return cfg.xp.defaultEmojiXp;
}
