// Entry point: creates the Discord client, wires events, and handles startup/shutdown.
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { applySlowmodes, handleMessageCreate } from './autothread.js';
import { getConfig, onConfigChange } from './config.js';
import { closeDb, getAllRatings, getUser, openDb, recalculateRatings } from './db.js';
import { readBotEnv } from './env.js';
import { commandDefinitions, handleInteraction } from './interactions.js';
import { log } from './logger.js';
import { handleMessageXp } from './messageXp.js';
import { handlePostBonus } from './channelBonuses.js';
import { flushAllRankUps } from './rankup.js';
import { startRecapSchedule, trackReactionAdd, trackReactionRemove, trackReactionRemoveAll, trackReactionRemoveEmoji } from './recap.js';
import { flushAllReactionBatches, handleReactionAdd, xpChannelIds } from './reactionXp.js';
import { ensureTierRoles, syncMemberTier, syncUsers } from './roles.js';

const env = readBotEnv();
getConfig(); // fail fast on an invalid config.json
openDb();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, // channels, threads, roles
    GatewayIntentBits.GuildMembers, // privileged: join events + full member list for /config sync-roles
    GatewayIntentBits.GuildMessages, // new messages for auto-threads
    GatewayIntentBits.GuildMessageReactions, // reaction XP
    GatewayIntentBits.MessageContent, // privileged: attachments/embeds/links for media detection
  ],
  // Partials let reactions on messages sent before the bot (re)started still arrive.
  partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.Channel, Partials.GuildMember, Partials.ThreadMember],
  // Nothing pings unless a message opts in explicitly (rank-ups do, per config).
  allowedMentions: { parse: [] },
});

let guild = null;

/** Re-derive ratings after the curve/tiers change and fix roles for anyone affected. Silent: no announcements. */
function resyncAfterCurveChange({ everyone = false } = {}) {
  const changed = recalculateRatings();
  const ids = everyone ? [...getAllRatings().keys()] : changed.map((c) => c.userId);
  if (changed.length) log.info(`Rating curve/tier change: ${changed.length} member rating(s) recalculated.`);
  if (guild && ids.length) syncUsers(guild, ids, 'Rating curve changed').catch((err) => log.warn('Resync failed:', err.message));
}

function watchConfig() {
  onConfigChange((prev, next) => {
    if (!prev || !guild) return;
    const same = (pick) => JSON.stringify(pick(prev)) === JSON.stringify(pick(next));
    const tiersSame = same((c) => c.tiers.map((t) => [t.minRating, t.roleId]));
    if (!same((c) => c.rating) || !tiersSame) resyncAfterCurveChange({ everyone: !tiersSame });
    if (!same((c) => c.autothread)) applySlowmodes(guild).catch((err) => log.warn('Slow mode update failed:', err.message));
  });
}

function warnAboutSetup() {
  const cfg = getConfig();
  if (cfg.rankup.enabled && cfg.rankup.postIn === 'channel' && !cfg.rankup.channelId) log.warn('No rank-up channel set: use /config rankup-channel.');
  if (!xpChannelIds(cfg).size) log.warn('No XP channels yet: use /config xpchannels add and /config autothread add.');
  if (!cfg.adminRoleId) log.warn('No admin role set: only Discord Administrators can use admin commands (/config admin-role).');
  if (cfg.recap.enabled && !cfg.recap.channelId) log.warn('No weekly recap channel set: use /config recap-channel.');
}

client.once(Events.ClientReady, async (c) => {
  log.info(`Logged in as ${c.user.tag}`);
  try {
    guild = await c.guilds.fetch(env.guildId);
  } catch {
    log.error(`The bot is not in server ${env.guildId}. Invite it first (npm run invite), then restart.`);
    process.exit(1);
  }

  // Guild commands update instantly (global ones can take up to an hour).
  await guild.commands.set(commandDefinitions);
  log.info(`Registered ${commandDefinitions.length} slash commands in ${guild.name}.`);

  await ensureTierRoles(guild).catch((err) => log.error('Tier role setup failed:', err.message));
  resyncAfterCurveChange(); // in case the curve was edited while the bot was offline
  await applySlowmodes(guild);
  watchConfig();
  startRecapSchedule(guild);
  warnAboutSetup();
  log.info('Ready.');
});

client.on(Events.MessageReactionAdd, (reaction, user) => {
  handleReactionAdd(reaction, user).catch((err) => log.error('Reaction handler failed:', err));
  trackReactionAdd(reaction, user).catch((err) => log.error('Recap tracking failed:', err));
});

// Removed reactions don't take XP away, but they do drop out of the weekly recap counts.
const safely = (fn) => (...args) => {
  try {
    fn(...args);
  } catch (err) {
    log.error('Recap tracking failed:', err);
  }
};
client.on(Events.MessageReactionRemove, safely(trackReactionRemove));
client.on(Events.MessageReactionRemoveAll, safely(trackReactionRemoveAll));
client.on(Events.MessageReactionRemoveEmoji, safely(trackReactionRemoveEmoji));

client.on(Events.MessageCreate, (message) => {
  handleMessageCreate(message).catch((err) => log.error('Message handler failed:', err));
  handleMessageXp(message).catch((err) => log.error('Message XP failed:', err));
  handlePostBonus(message).catch((err) => log.error('Post bonus failed:', err));
});

client.on(Events.GuildMemberAdd, (member) => {
  if (member.guild.id !== env.guildId || member.user.bot) return;
  // Rejoining members get their tier back; new members get the starting tier if enabled.
  if (getConfig().roles.assignStartingTierOnJoin || getUser(member.id)) {
    syncMemberTier(member, 'Member joined').catch((err) => log.warn(`Join role failed: ${err.message}`));
  }
});

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch((err) => log.error('Interaction failed:', err));
});

client.on(Events.Error, (err) => log.error('Client error:', err));
process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down...`);
  // Grant reactions still in their batching window and post pending rank-ups (max 5s).
  await Promise.race([
    (async () => {
      await flushAllReactionBatches();
      await flushAllRankUps();
    })(),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  await client.destroy();
  closeDb();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(env.token).catch((err) => {
  log.error(`Login failed: ${err.message} Check DISCORD_TOKEN, and that both privileged intents are enabled in the Developer Portal.`);
  process.exit(1);
});
