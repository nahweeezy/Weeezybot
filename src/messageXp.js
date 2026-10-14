// Small XP for chatting: each message has a `messageXp.chance` chance to give `messageXp.xp` XP,
// but a member can get message XP at most once per `messageXp.cooldownMinutes`.
// The cooldown is stored in the database (pair_locks, with a fixed "giver" ID), so restarts don't reset it.
import { MessageType } from 'discord.js';
import { autothreadSettings, hasMedia } from './autothread.js';
import { getConfig } from './config.js';
import { isPairLocked, tryReactionGrant } from './db.js';
import { guildId } from './env.js';
import { applyRatingChange } from './progression.js';
import { isXpChannel, xpChannelIds } from './reactionXp.js';

const MESSAGE_GIVER = 'message'; // stands in for the "giver" in the cooldown lock and the XP log

export async function handleMessageXp(message, { random = Math.random } = {}) {
  const cfg = getConfig();
  const mx = cfg.messageXp;
  if (!mx.enabled || mx.xp <= 0) return null;
  if (!message.inGuild() || message.guildId !== guildId()) return null;
  if (message.author.bot || message.webhookId || message.system) return null;
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return null;
  if (mx.onlyXpChannels && !isXpChannel(message.channel, xpChannelIds(cfg))) return null;

  // Text-only posts in media-only channels get deleted, so they shouldn't earn anything.
  const settings = autothreadSettings(message.channelId, cfg);
  if (settings?.mediaOnly && !hasMedia(message, cfg)) return null;

  const cooldownMs = mx.cooldownMinutes * 60 * 1000;
  if (isPairLocked(MESSAGE_GIVER, message.author.id, cooldownMs)) return null; // already got it this hour
  if (random() >= mx.chance) return null; // unlucky roll: try again next message

  const result = tryReactionGrant(
    [{
      giverId: MESSAGE_GIVER,
      receiverId: message.author.id,
      receiverName: message.author.username,
      messageId: message.id,
      channelId: message.channelId,
      emojiDisplay: null,
      amount: mx.xp,
      receivedAt: Date.now(),
    }],
    { cooldownMs, oncePerMessage: false, kind: 'message' },
  );
  if (result) await applyRatingChange(message.guild, result, { sourceChannelId: message.channelId });
  return result;
}
