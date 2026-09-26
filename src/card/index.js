// Builds a member's card: gathers their stats, renders the PNG, or falls back to an embed.
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { getConfig } from '../config.js';
import { getProfile } from '../db.js';
import { log } from '../logger.js';
import { progressFor, tierForRating } from '../rating.js';
import { formatNumber } from '../util.js';
import { renderCard } from './render.js';

export const CARD_FILE_NAME = 'card.png';

async function fetchImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** The card font has no emoji glyphs, so strip them rather than drawing empty boxes. */
function cleanName(name) {
  const cleaned = name
    .replace(/[\p{Extended_Pictographic}‍️⃣]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Player';
}

/** 950 -> "950", 12,400 -> "12.4K", 1,250,000 -> "1.3M" (keeps card stats short). */
function compact(n) {
  if (n < 10_000) return formatNumber(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Everything shown on a card, for both the image and the embed fallback. */
export function getCardInfo(user, member) {
  const cfg = getConfig();
  const profile = getProfile(user.id);
  const progress = progressFor(profile.xp, cfg);
  const tier = tierForRating(progress.rating, cfg);
  return {
    name: member?.displayName ?? user.globalName ?? user.username,
    profile,
    progress,
    tier,
  };
}

/** Render the card image. Returns an AttachmentBuilder, or null if rendering failed. */
export async function renderCardAttachment({ user, member, guild }) {
  try {
    const { name, profile, progress, tier } = getCardInfo(user, member);
    const avatarUrl = (member ?? user).displayAvatarURL({ extension: 'png', size: 256, forceStatic: true });
    const badgeUrl = guild?.iconURL({ extension: 'png', size: 128, forceStatic: true });
    const [avatar, badge] = await Promise.all([fetchImage(avatarUrl), fetchImage(badgeUrl)]);

    const png = await renderCard({
      name: cleanName(name),
      avatar,
      badge,
      rating: progress.rating,
      tier,
      stats: [
        { label: 'XP', value: compact(profile.xp) },
        { label: 'NXT', value: progress.isMax ? 'MAX' : compact(progress.xpToNext) },
        { label: 'RNK', value: profile.rank ? `#${compact(profile.rank)}` : '-' },
        { label: 'RCT', value: compact(profile.reactionsReceived) },
        { label: 'FAN', value: compact(profile.uniqueReactors) },
        { label: 'HOT', value: compact(profile.hotReactions) },
      ],
      progress: {
        fraction: progress.fraction,
        text: progress.isMax
          ? 'MAX RATING'
          : `${formatNumber(profile.xp - progress.floorXp)} / ${formatNumber(progress.nextXp - progress.floorXp)} XP TO ${progress.nextRating}`,
      },
    });
    return new AttachmentBuilder(png, { name: CARD_FILE_NAME });
  } catch (err) {
    log.warn(`Card render failed for ${user.id}: ${err.message}`);
    return null;
  }
}

/** Text-only version of the card, used when image generation fails. */
export function buildCardEmbed({ user, member }) {
  const cfg = getConfig();
  const { name, profile, progress, tier } = getCardInfo(user, member);
  const next = progress.isMax ? 'Max rating' : `${formatNumber(progress.xpToNext)} XP to ${progress.nextRating}`;
  return new EmbedBuilder()
    .setColor(tier.color)
    .setTitle(`${tier.emoji} ${name} · ${progress.rating} OVR`)
    .setThumbnail((member ?? user).displayAvatarURL({ size: 256 }))
    .addFields(
      { name: 'Tier', value: tier.name, inline: true },
      { name: 'XP', value: formatNumber(profile.xp), inline: true },
      { name: 'Next rating', value: next, inline: true },
      { name: 'Reactions received', value: formatNumber(profile.reactionsReceived), inline: true },
      { name: 'Unique reactors', value: formatNumber(profile.uniqueReactors), inline: true },
      { name: `${cfg.card.hotEmoji} received`, value: formatNumber(profile.hotReactions), inline: true },
      { name: 'Leaderboard', value: profile.rank ? `#${formatNumber(profile.rank)}` : 'Unranked', inline: true },
    );
}
