// Feature 4: automatic threads on media posts in designated channels, optional media-only
// enforcement, and bot-managed slow mode. Settings: config.autothread (defaults + per channel).
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, MessageType, PermissionFlagsBits } from 'discord.js';
import { getConfig } from './config.js';
import { recordReactionSeen, tryReactionGrant } from './db.js';
import { emojiKey } from './emoji.js';
import { guildId } from './env.js';
import { log } from './logger.js';
import { isAdmin } from './permissions.js';
import { applyRatingChange } from './progression.js';
import { fillTemplate, sleep } from './util.js';

const URL_RE = /https?:\/\/[^\s<>]+/gi;
const HAS_URL_RE = /https?:\/\//i;
const MEDIA_EMBED_TYPES = new Set(['image', 'video', 'gifv']);
const MEDIA_FILE_RE = /\.(png|jpe?g|gif|webp|avif|heic|bmp|mp4|mov|webm|mkv|m4v)$/i;

const lastNoticeAt = new Map(); // userId -> when we last DMed them the media-only note

/** Effective settings for a channel (defaults + overrides), or null if auto-threads are off there. */
export function autothreadSettings(channelId, cfg = getConfig()) {
  const overrides = cfg.autothread.channels[channelId];
  return overrides ? { ...cfg.autothread.defaults, ...overrides } : null;
}

let patternCache = { source: null, regexes: [] };
function mediaLinkRegexes(cfg) {
  if (patternCache.source !== cfg.autothread.mediaLinkPatterns) {
    patternCache = {
      source: cfg.autothread.mediaLinkPatterns,
      regexes: cfg.autothread.mediaLinkPatterns.map((p) => new RegExp(p, 'i')),
    };
  }
  return patternCache.regexes;
}

function isMediaAttachment(attachment) {
  if (attachment.contentType) return /^(image|video)\//i.test(attachment.contentType);
  return MEDIA_FILE_RE.test(attachment.name ?? '');
}

/** True if the message carries an image/video: an upload, a media embed, or a known media link. */
export function hasMedia(message, cfg = getConfig()) {
  if (message.attachments.some(isMediaAttachment)) return true;
  if (message.embeds.some((e) => MEDIA_EMBED_TYPES.has(e.data.type) || e.image || e.video)) return true;
  const urls = message.content.match(URL_RE) ?? [];
  const regexes = mediaLinkRegexes(cfg);
  return urls.some((url) => regexes.some((re) => re.test(url)));
}

function isExempt(member, cfg) {
  return isAdmin(member, cfg) || cfg.autothread.exemptRoleIds.some((id) => member?.roles.cache.has(id));
}

export async function handleMessageCreate(message) {
  if (!message.inGuild() || message.guildId !== guildId()) return;
  if (message.author.bot || message.webhookId || message.system) return;
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;

  const cfg = getConfig();
  const settings = autothreadSettings(message.channelId, cfg);
  if (!settings) return;

  let media = hasMedia(message, cfg);
  if (!media && HAS_URL_RE.test(message.content) && cfg.autothread.embedWaitMs > 0) {
    // Discord attaches link previews a moment after the message is sent; wait and look again.
    await sleep(cfg.autothread.embedWaitMs);
    message = await message.fetch().catch(() => null);
    if (!message) return; // deleted in the meantime
    media = hasMedia(message, cfg);
  }

  if (media) await createThread(message, settings);
  else if (settings.mediaOnly && !isExempt(message.member, cfg)) await enforceMediaOnly(message, cfg);
}

async function createThread(message, settings) {
  if (message.hasThread) return;
  const vars = {
    username: message.author.username,
    displayName: message.member?.displayName ?? message.author.displayName,
    channel: message.channel.name,
  };
  const name = fillTemplate(settings.nameFormat, vars).trim().slice(0, 100) || 'Discussion';
  let thread;
  try {
    thread = await message.startThread({ name, autoArchiveDuration: settings.autoArchiveMinutes, reason: 'Auto-thread for media post' });
  } catch (err) {
    log.warn(`Couldn't create a thread in #${message.channel.name}: ${err.message}`);
    return;
  }
  await postCloseButton(thread, message.author.id, vars);
  await giveThreadBonus(message);
}

// ---------------------------------------------------------------------------
// "Close thread" button. The bot owns auto-threads, so posters can't close them through
// Discord's own UI; this button lets the original poster (or an admin/mod) do it.
// Button IDs look like "tc:<posterId>" so they keep working after restarts.
// ---------------------------------------------------------------------------

async function postCloseButton(thread, posterId, vars) {
  const cb = getConfig().autothread.closeButton;
  if (!cb.enabled) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tc:${posterId}`).setLabel(cb.label).setEmoji('🔒').setStyle(ButtonStyle.Secondary),
  );
  const content = fillTemplate(cb.message, vars).trim() || undefined;
  await thread.send({ content, components: [row] }).catch((err) => log.warn(`Couldn't post the close button: ${err.message}`));
}

export const closeThreadButton = {
  buttonPrefix: 'tc:',
  async handleButton(interaction) {
    const posterId = interaction.customId.split(':')[1];
    const thread = interaction.channel;
    const cfg = getConfig();
    const canClose =
      interaction.user.id === posterId ||
      isAdmin(interaction.member, cfg) ||
      interaction.member?.permissionsIn(thread).has(PermissionFlagsBits.ManageThreads);
    if (!canClose) {
      await interaction.reply({ content: 'Only the person who posted this can close the thread.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!thread?.isThread()) return;

    // Answer first (Discord wants a reply within 3s), then archive.
    await interaction.reply({ content: `🔒 Thread closed by <@${interaction.user.id}>.`, allowedMentions: { parse: [] } });
    try {
      if (cfg.autothread.closeButton.lock) await thread.setLocked(true, 'Closed with the close button');
      await thread.setArchived(true, 'Closed with the close button');
    } catch (err) {
      log.warn(`Couldn't close thread ${thread.name}: ${err.message}`);
    }
  },
};

/**
 * Reward posting: the bot reacts (🔥 by default) to the post that got a thread and grants the
 * author XP for it. Limited to once per member per autothread.threadBonus.cooldownHours so
 * spamming images can't farm XP. Normal member reactions still earn XP on top of this.
 */
async function giveThreadBonus(message) {
  const bonus = getConfig().autothread.threadBonus;
  if (!bonus.enabled) return;

  let reaction = null;
  try {
    reaction = await message.react(bonus.emoji);
  } catch (err) {
    log.warn(`Couldn't react to a post in #${message.channel.name} (needs Add Reactions): ${err.message}`);
  }
  if (bonus.xp <= 0) return;

  const botId = message.client.user.id;
  const emoji = reaction?.emoji ?? { name: bonus.emoji };
  recordReactionSeen({ messageId: message.id, giverId: botId, emojiKey: emojiKey(emoji), receiverId: message.author.id, channelId: message.channelId });
  const result = tryReactionGrant(
    [{ giverId: botId, receiverId: message.author.id, receiverName: message.author.username, messageId: message.id,
       channelId: message.channelId, emojiDisplay: bonus.emoji, amount: bonus.xp, receivedAt: Date.now() }],
    { cooldownMs: bonus.cooldownHours * 60 * 60 * 1000, oncePerMessage: true, kind: 'thread_bonus' },
  );
  if (result) await applyRatingChange(message.guild, result, { sourceChannelId: message.channelId });
}

async function enforceMediaOnly(message, cfg) {
  try {
    await message.delete();
  } catch (err) {
    log.warn(`Couldn't delete a text-only message in #${message.channel.name}: ${err.message}`);
    return;
  }

  // Optional per-person cooldown so someone spamming text doesn't get a notice every time.
  const now = Date.now();
  const cooldown = cfg.autothread.mediaOnlyNoticeCooldownMinutes * 60 * 1000;
  if (cooldown > 0) {
    if (now - (lastNoticeAt.get(message.author.id) ?? 0) < cooldown) return;
    lastNoticeAt.set(message.author.id, now);
    if (lastNoticeAt.size > 5000) {
      for (const [id, at] of lastNoticeAt) if (now - at >= cooldown) lastNoticeAt.delete(id);
    }
  }

  const text = fillTemplate(cfg.autothread.mediaOnlyNotice, {
    mention: `<@${message.author.id}>`,
    username: message.author.username,
    displayName: message.member?.displayName ?? message.author.displayName,
    channel: `<#${message.channelId}>`,
    server: message.guild.name,
  }).trim();
  if (!text) return;

  // Short-lived notice in the channel itself, removed after mediaOnlyNoticeDeleteSeconds.
  try {
    const notice = await message.channel.send({ content: text, allowedMentions: { users: [message.author.id] } });
    const seconds = cfg.autothread.mediaOnlyNoticeDeleteSeconds;
    if (seconds > 0) setTimeout(() => notice.delete().catch(() => {}), seconds * 1000);
  } catch (err) {
    log.warn(`Couldn't post the media-only notice in #${message.channel.name}: ${err.message}`);
  }
}

/** Apply configured slow mode to every auto-thread channel (null = leave the channel alone). */
export async function applySlowmodes(guild) {
  const cfg = getConfig();
  for (const channelId of Object.keys(cfg.autothread.channels)) {
    const { slowmodeSeconds } = autothreadSettings(channelId, cfg);
    if (slowmodeSeconds === null) continue;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      log.warn(`Auto-thread channel ${channelId} not found.`);
      continue;
    }
    if (channel.rateLimitPerUser === slowmodeSeconds) continue;
    try {
      await channel.setRateLimitPerUser(slowmodeSeconds, 'Slow mode from bot config');
      log.info(`Set slow mode in #${channel.name} to ${slowmodeSeconds}s.`);
    } catch (err) {
      log.warn(`Couldn't set slow mode in #${channel.name}: ${err.message}`);
    }
  }
}
