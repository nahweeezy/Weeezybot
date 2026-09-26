// What happens after any XP change: tier roles update right away, rating increases get announced.
import { getConfig } from './config.js';
import { log } from './logger.js';
import { recordRatingChange } from './rankup.js';
import { syncMemberTier } from './roles.js';

/**
 * @param guild   the server
 * @param change  { userId, oldRating, newRating } as returned by the db XP functions
 * @param manual  true for admin corrections (announced only if rankup.announceManualChanges)
 * @param sourceChannelId  where the XP was earned (rank-ups can be posted there)
 */
export async function applyRatingChange(guild, change, { manual = false, sourceChannelId = null } = {}) {
  if (change.oldRating === change.newRating) return;
  const cfg = getConfig();

  recordRatingChange(guild, change.userId, change.oldRating, change.newRating, {
    announce: !manual || cfg.rankup.announceManualChanges,
    sourceChannelId,
  });

  const member = await guild.members.fetch(change.userId).catch(() => null);
  if (!member) return;
  try {
    await syncMemberTier(member);
  } catch (err) {
    log.warn(`Couldn't update tier role for ${member.user.tag}: ${err.message}`);
  }
}
