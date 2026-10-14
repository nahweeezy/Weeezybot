// Weekly recap: tracks reactions on every message in the server, and once a week posts the
// most-reacted posts of the last `recap.lookbackDays` days in `recap.channelId`, pinging the
// authors and showing who reacted. Settings: config.recap.
import { EmbedBuilder } from 'discord.js';
import { getConfig } from './config.js';
import * as db from './db.js';
import { emojiDisplay, emojiKey } from './emoji.js';
import { guildId } from './env.js';
import { log } from './logger.js';
import { tierForRating } from './rating.js';
import { fillTemplate, formatNumber } from './util.js';

const DAY = 24 * 60 * 60 * 1000;
const plural = (n, one, many) => `${formatNumber(n)} ${n === 1 ? one : many}`;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LAST_RECAP_KEY = 'recap_last_date';

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

/** Remember a reaction (any channel). Bots, bot messages and self-reactions are ignored. */
export async function trackReactionAdd(reaction, user) {
  let message;
  try {
    if (user.partial) user = await user.fetch();
    if (user.bot) return;
    if (reaction.partial) reaction = await reaction.fetch();
    message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  } catch {
    return; // deleted before we could read it
  }
  if (!message.inGuild() || message.guildId !== guildId()) return;
  if (!message.author || message.author.bot || message.webhookId || message.system) return;
  if (message.author.id === user.id) return;

  db.recordMessageReaction({
    messageId: message.id,
    userId: user.id,
    emoji: emojiKey(reaction.emoji),
    emojiDisplay: emojiDisplay(reaction.emoji),
    channelId: message.channelId,
    authorId: message.author.id,
    messageCreatedAt: message.createdTimestamp,
  });
}

export function trackReactionRemove(reaction, user) {
  if (reaction.message.guildId !== guildId()) return;
  db.removeMessageReactions(reaction.message.id, { userId: user.id, emoji: emojiKey(reaction.emoji) });
}

export function trackReactionRemoveAll(message) {
  if (message.guildId !== guildId()) return;
  db.removeMessageReactions(message.id);
}

export function trackReactionRemoveEmoji(reaction) {
  if (reaction.message.guildId !== guildId()) return;
  db.removeMessageReactions(reaction.message.id, { emoji: emojiKey(reaction.emoji) });
}

// ---------------------------------------------------------------------------
// Building and posting the recap
// ---------------------------------------------------------------------------

function firstImageUrl(message) {
  const image = message.attachments.find((a) => a.contentType?.startsWith('image/'));
  if (image) return image.url;
  const embed = message.embeds.find((e) => e.image || e.thumbnail);
  return embed?.image?.url ?? embed?.thumbnail?.url ?? null;
}

function snippet(text, max = 200) {
  const clean = (text ?? '').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Build the recap message payload, or null if nothing got reactions this week.
 * Posts that were deleted since are skipped (the next one moves up).
 */
export async function buildRecap(guild, now = Date.now()) {
  const cfg = getConfig();
  const rc = cfg.recap;
  const candidates = db.getTopMessages(now - rc.lookbackDays * DAY, rc.count * 3);

  const picks = [];
  for (const row of candidates) {
    if (picks.length >= rc.count) break;
    const channel = await guild.client.channels.fetch(row.channel_id).catch(() => null);
    const message = await channel?.messages?.fetch(row.message_id).catch(() => null);
    if (!message) continue;
    picks.push({ row, message, channel });
  }
  if (!picks.length) return null;

  const medals = ['🥇', '🥈', '🥉'];
  const lines = picks.map(({ row }, i) => `${medals[i] ?? `**#${i + 1}**`} <@${row.author_id}> · ${plural(row.total, 'reaction', 'reactions')}`);

  const embeds = picks.map(({ row, message, channel }, i) => {
    const member = guild.members.cache.get(row.author_id);
    const author = member?.user ?? message.author;
    const rating = db.getUser(row.author_id)?.rating ?? cfg.rating.min;
    const shown = row.reactors.slice(0, rc.maxReactorsShown).map((id) => `<@${id}>`);
    const more = row.reactors.length - shown.length;
    const text = snippet(message.content);

    const embed = new EmbedBuilder()
      .setColor(tierForRating(rating, cfg).color)
      .setAuthor({ name: `#${i + 1} · ${member?.displayName ?? author.username}`, iconURL: (member ?? author).displayAvatarURL({ size: 64 }) })
      .setDescription(`${text ? `${text}\n\n` : ''}in <#${channel.id}> · [jump to post](${message.url})`)
      .addFields(
        {
          name: `${plural(row.total, 'reaction', 'reactions')} from ${plural(row.people, 'person', 'people')}`,
          value: row.emojis.map((e) => `${e.emoji_display} ${e.n}`).join('  ').slice(0, 1024) || '-',
        },
        { name: 'Reacted by', value: `${shown.join(' ')}${more > 0 ? ` +${more} more` : ''}`.slice(0, 1024) },
      )
      .setTimestamp(message.createdTimestamp);
    const image = firstImageUrl(message);
    if (image) embed.setImage(image);
    return embed;
  });

  const header = fillTemplate(rc.message, { server: guild.name }).trim();
  return {
    content: [header, ...lines].filter(Boolean).join('\n'),
    embeds,
    allowedMentions: { users: [...new Set(picks.map((p) => p.row.author_id))] }, // ping the authors only
  };
}

/** Post the recap now. Returns a short status string for logs / the admin command. */
export async function postRecap(guild, channelId = getConfig().recap.channelId) {
  const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (!channel?.isTextBased()) return 'no recap channel set (use /config recap-channel)';
  const payload = await buildRecap(guild);
  if (!payload) return 'nothing got reactions this week, so no recap was posted';
  await channel.send(payload);
  // Rows older than a month can never show up in a recap again.
  db.pruneMessageReactions(Date.now() - 31 * DAY);
  return `posted the top ${payload.embeds.length} in #${channel.name}`;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** Day of week, hour, minute and calendar date in the configured timezone ("" = host clock). */
function localTime(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || undefined,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { day: WEEKDAYS.indexOf(p.weekday), hour: Number(p.hour), minute: Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}

/**
 * Check once a minute. Posts on the configured day once the configured time has passed; the
 * date of the last recap is stored in the DB so restarts never double-post, and if the bot
 * was offline at the scheduled time it still posts later that same day.
 */
export function startRecapSchedule(guild) {
  let running = false;
  const tick = async () => {
    const rc = getConfig().recap;
    if (running || !rc.enabled || !rc.channelId) return;
    const now = localTime(new Date(), rc.timezone);
    const due = now.day === rc.dayOfWeek && (now.hour > rc.hour || (now.hour === rc.hour && now.minute >= rc.minute));
    if (!due || db.getMeta(LAST_RECAP_KEY) === now.date) return;

    running = true;
    try {
      db.setMeta(LAST_RECAP_KEY, now.date);
      log.info(`Weekly recap: ${await postRecap(guild, rc.channelId)}`);
    } catch (err) {
      log.error('Weekly recap failed:', err);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, 60 * 1000);
}
