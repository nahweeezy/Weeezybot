// Tier roles: make sure they exist, and keep each member holding exactly the role for their tier.
import { getConfig, updateConfig } from './config.js';
import { getUser } from './db.js';
import { log } from './logger.js';
import { ratingForXp, tierForRating } from './rating.js';
import { runExclusive } from './util.js';

/**
 * Resolve a role for every tier. Uses tier.roleId when set; otherwise (if roles.autoCreate)
 * reuses a role with the tier's name or creates one, and saves the ID back into config.json.
 */
export async function ensureTierRoles(guild) {
  const cfg = getConfig();
  await guild.roles.fetch();
  const created = new Map();

  // New roles are inserted at the bottom of the list, so create the highest tier first
  // to end up with 99 on top and Bronze at the bottom.
  for (const tier of [...cfg.tiers].reverse()) {
    let role = tier.roleId ? guild.roles.cache.get(tier.roleId) : null;
    if (tier.roleId && !role) log.warn(`Tier "${tier.name}": configured role ${tier.roleId} does not exist.`);

    if (!role && cfg.roles.autoCreate) {
      role = guild.roles.cache.find((r) => r.name === tier.name);
      if (!role) {
        role = await guild.roles.create({
          name: tier.name,
          colors: { primaryColor: tier.color },
          hoist: cfg.roles.hoist,
          mentionable: false,
          permissions: [],
          reason: 'Rating tier role',
        });
        log.info(`Created tier role "${tier.name}" (${role.id}).`);
      }
      created.set(tier.key, role.id);
    }

    if (!role) log.warn(`Tier "${tier.name}" has no role; members in it won't get one.`);
    else if (!role.editable) {
      log.warn(`Can't assign "${role.name}": drag the bot's role above it in Server Settings → Roles.`);
    }
  }

  if (created.size) {
    updateConfig((draft) => {
      for (const tier of draft.tiers) if (created.has(tier.key)) tier.roleId = created.get(tier.key);
    });
  }
}

/** Current rating for a member, straight from the database (starting rating if they have no row). */
function currentRating(userId) {
  const row = getUser(userId);
  return row ? row.rating : ratingForXp(0);
}

/**
 * Give the member their tier role and strip any other tier role. Reads the latest rating
 * from the DB when it runs, so rapid back-to-back changes always settle on the right tier.
 */
export function syncMemberTier(member, reason = 'Rating tier changed') {
  return runExclusive(`roles:${member.id}`, async () => {
    if (member.user.bot) return false;
    const cfg = getConfig();
    const tier = tierForRating(currentRating(member.id), cfg);
    const roles = member.guild.roles.cache;

    const remove = cfg.tiers
      .map((t) => t.roleId)
      .filter((id) => id && id !== tier.roleId && member.roles.cache.has(id) && roles.get(id)?.editable);
    const add = tier.roleId && roles.get(tier.roleId)?.editable && !member.roles.cache.has(tier.roleId) ? tier.roleId : null;

    if (remove.length) await member.roles.remove(remove, reason);
    if (add) await member.roles.add(add, reason);
    return Boolean(remove.length || add);
  });
}

/** Sync a batch of users by ID (skips anyone who has left the server). */
export async function syncUsers(guild, userIds, reason) {
  for (const userId of userIds) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    await syncMemberTier(member, reason).catch((err) => log.warn(`Role sync failed for ${userId}: ${err.message}`));
  }
}

/** Walk every member of the server and fix their tier role. Used by /config sync-roles. */
export async function syncAllMembers(guild, { onProgress } = {}) {
  const members = await guild.members.fetch();
  const total = members.filter((m) => !m.user.bot).size;
  let changed = 0;
  let failed = 0;
  let checked = 0;
  for (const member of members.values()) {
    if (member.user.bot) continue;
    checked++;
    try {
      if (await syncMemberTier(member, 'Tier role sync')) changed++;
      if (onProgress && checked % 50 === 0) onProgress({ checked, total, changed });
    } catch (err) {
      failed++;
      log.warn(`Role sync failed for ${member.user.tag}: ${err.message}`);
    }
  }
  return { checked, changed, failed };
}
