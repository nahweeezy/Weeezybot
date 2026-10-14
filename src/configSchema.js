// Validation rules for config.json. The schema only checks shape and ranges;
// every actual value lives in config.json, so nothing tunable is hardcoded here.
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID (17-20 digits)');
const optionalSnowflake = z.union([z.literal(''), snowflake]);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex color like #FFAA00');
const nonNegInt = z.number().int().min(0);

// Discord only accepts these auto-archive durations for threads.
const autoArchiveMinutes = z.union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)]);

const autothreadSettings = z.strictObject({
  nameFormat: z.string().min(1).max(100),
  mediaOnly: z.boolean(),
  // null = leave the channel's slow mode alone; a number (0 = off) is enforced by the bot.
  slowmodeSeconds: z.number().int().min(0).max(21600).nullable(),
  autoArchiveMinutes,
});

const cardStyle = z.strictObject({
  background: z.array(hexColor).min(1).max(5),
  border: hexColor,
  text: hexColor,
  accent: hexColor,
  pattern: z.enum(['none', 'shine', 'rays', 'holo']),
});

const tier = z.strictObject({
  key: z.string().regex(/^[a-z0-9_]+$/, 'use lowercase letters, digits and _'),
  name: z.string().min(1).max(40),
  minRating: z.number().int(),
  roleId: optionalSnowflake,
  color: hexColor,
  emoji: z.string().max(64),
  announcePromotion: z.boolean(),
  card: cardStyle,
});

const anchor = z.strictObject({
  rating: z.number().int(),
  xp: nonNegInt,
  // Shape of the segment that ENDS at this anchor: 1 = linear, >1 = cheap early levels, pricier late levels.
  easing: z.number().positive().max(10).optional(),
});

const configSchema = z
  .strictObject({
    adminRoleId: optionalSnowflake,
    allowDiscordAdministrators: z.boolean(),
    xp: z.strictObject({
      channels: z.array(snowflake),
      includeAutothreadChannels: z.boolean(),
      emojiValues: z.record(z.string().min(1), z.number().int().min(0).max(10000)),
      defaultEmojiXp: z.number().int().min(0).max(10000),
      pairCooldownHours: z.number().min(0).max(24 * 365),
      oncePerMessage: z.boolean(),
      simultaneousReactionWindowMs: z.number().int().min(0).max(60000),
    }),
    // Flat XP for posting in a channel, per channel: { "<channelId>": { xp, cooldownHours, requires } }.
    postBonus: z.record(
      snowflake,
      z.strictObject({
        xp: z.number().int().min(0).max(10000),
        cooldownHours: z.number().min(0).max(24 * 365),
        requires: z.enum(['media', 'any']),
      }),
    ),
    // XP multiplier for reactions and message XP per channel/category: { "<channelId>": 2 }.
    channelMultipliers: z.record(snowflake, z.number().min(0).max(10)),
    // Chance-based XP for sending messages, capped by a per-member cooldown.
    messageXp: z.strictObject({
      enabled: z.boolean(),
      chance: z.number().min(0).max(1),
      xp: z.number().int().min(0).max(1000),
      cooldownMinutes: z.number().min(0).max(24 * 60 * 7),
      onlyXpChannels: z.boolean(),
    }),
    rating: z.strictObject({
      min: z.number().int().min(0),
      max: z.number().int().min(1),
      curve: z.strictObject({
        type: z.enum(['anchors', 'table']),
        anchors: z.array(anchor),
        table: z.record(z.string().regex(/^\d+$/), nonNegInt),
      }),
    }),
    tiers: z.array(tier).min(1),
    roles: z.strictObject({
      autoCreate: z.boolean(),
      hoist: z.boolean(),
      assignStartingTierOnJoin: z.boolean(),
    }),
    rankup: z.strictObject({
      enabled: z.boolean(), // false = never post rank-up messages (roles still update)
      postIn: z.enum(['source', 'channel']),
      channelId: optionalSnowflake,
      deleteAfterSeconds: z.number().min(0).max(3600),
      announceManualChanges: z.boolean(),
      coalesceSeconds: z.number().min(0).max(300),
      pingOnBump: z.boolean(),
      pingOnPromotion: z.boolean(),
      bumpMessage: z.string().min(1).max(2000),
      multiBumpMessage: z.string().min(1).max(2000),
      promotion: z.strictObject({
        content: z.string().max(2000),
        title: z.string().min(1).max(256),
        description: z.string().min(1).max(4000),
        attachCard: z.boolean(),
      }),
    }),
    autothread: z.strictObject({
      // Per-channel overrides; any field left out falls back to `defaults`.
      channels: z.record(snowflake, autothreadSettings.partial()),
      defaults: autothreadSettings,
      embedWaitMs: z.number().int().min(0).max(15000),
      mediaLinkPatterns: z.array(z.string().min(1)),
      mediaOnlyNotice: z.string().max(1800),
      mediaOnlyNoticeCooldownMinutes: z.number().min(0),
      mediaOnlyNoticeDeleteSeconds: z.number().min(0).max(600),
      exemptRoleIds: z.array(snowflake),
      // Bot reacts to posts that get an auto-thread and gives the author XP.
      // Button posted in each auto-thread so the original poster can close it.
      closeButton: z.strictObject({
        enabled: z.boolean(),
        label: z.string().min(1).max(80),
        message: z.string().max(2000),
        lock: z.boolean(),
      }),
      threadBonus: z.strictObject({
        enabled: z.boolean(),
        emoji: z.string().min(1).max(64),
        xp: z.number().int().min(0).max(10000),
        cooldownHours: z.number().min(0).max(24 * 365),
      }),
    }),
    recap: z.strictObject({
      enabled: z.boolean(),
      channelId: optionalSnowflake,
      dayOfWeek: z.number().int().min(0).max(6), // 0 = Sunday
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      timezone: z.string().refine(validTimezone, 'unknown timezone (use e.g. "America/New_York", or "" for the host clock)'),
      lookbackDays: z.number().min(1).max(31),
      count: z.number().int().min(1).max(10),
      maxReactorsShown: z.number().int().min(1).max(50),
      message: z.string().max(1500),
    }),
    leaderboard: z.strictObject({
      pageSize: z.number().int().min(1).max(25),
    }),
    card: z.strictObject({
      hotEmoji: z.string().min(1),
    }),
  })
  .superRefine((cfg, ctx) => {
    const issue = (path, message) => ctx.addIssue({ code: 'custom', path, message });
    const { min, max, curve } = cfg.rating;

    if (min >= max) issue(['rating', 'max'], 'rating.max must be greater than rating.min');

    if (curve.type === 'anchors') {
      const a = curve.anchors;
      if (a.length < 2) issue(['rating', 'curve', 'anchors'], 'need at least two anchors');
      else {
        if (a[0].rating !== min || a[0].xp !== 0) {
          issue(['rating', 'curve', 'anchors', 0], `first anchor must be { rating: ${min}, xp: 0 }`);
        }
        if (a.at(-1).rating !== max) {
          issue(['rating', 'curve', 'anchors', a.length - 1], `last anchor must be rating ${max}`);
        }
        for (let i = 1; i < a.length; i++) {
          if (a[i].rating <= a[i - 1].rating || a[i].xp <= a[i - 1].xp) {
            issue(['rating', 'curve', 'anchors', i], 'anchor ratings and xp must both strictly increase');
          } else if (a[i].xp - a[i - 1].xp < a[i].rating - a[i - 1].rating) {
            issue(['rating', 'curve', 'anchors', i], 'needs at least 1 XP per rating since the previous anchor');
          }
        }
      }
    } else {
      let prev = -1;
      for (let r = min; r <= max; r++) {
        const v = curve.table[String(r)];
        if (v === undefined) issue(['rating', 'curve', 'table'], `missing entry for rating ${r}`);
        else if (r === min && v !== 0) issue(['rating', 'curve', 'table', String(r)], 'the minimum rating must need 0 XP');
        else if (v <= prev) issue(['rating', 'curve', 'table', String(r)], 'XP must strictly increase with rating');
        if (v !== undefined) prev = v;
      }
    }

    const tiers = cfg.tiers;
    if (tiers[0].minRating !== min) issue(['tiers', 0, 'minRating'], `first tier must start at rating.min (${min})`);
    const keys = new Set();
    tiers.forEach((t, i) => {
      if (keys.has(t.key)) issue(['tiers', i, 'key'], `duplicate tier key "${t.key}"`);
      keys.add(t.key);
      if (t.minRating > max) issue(['tiers', i, 'minRating'], `must be <= rating.max (${max})`);
      if (i > 0 && t.minRating <= tiers[i - 1].minRating) issue(['tiers', i, 'minRating'], 'tiers must be sorted by increasing minRating');
    });

    cfg.autothread.mediaLinkPatterns.forEach((p, i) => {
      try {
        new RegExp(p, 'i');
      } catch (err) {
        issue(['autothread', 'mediaLinkPatterns', i], `invalid regex: ${err.message}`);
      }
    });
  });

function validTimezone(tz) {
  if (tz === '') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export class ConfigError extends Error {}

/**
 * Validate a raw config object. Returns the same object (key order preserved) or throws
 * a ConfigError listing every problem as "path: message".
 */
export function validateConfig(raw) {
  const result = configSchema.safeParse(raw);
  if (result.success) return raw;
  const lines = result.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new ConfigError(`Invalid config:\n${lines.join('\n')}`);
}
