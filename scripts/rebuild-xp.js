// Rebuild everyone's XP from the reactions still visible on Discord. Stop the bot first.
//   npm run rebuild-xp                 last 90 days
//   npm run rebuild-xp -- --days 30
// On a panel host you can run it by setting the startup file to scripts/rebuild-xp.js,
// starting the server once, then setting it back to src/index.js.
//
// Any existing database is kept next to the new one as *.before-rebuild-<time>.db.
import fs from 'node:fs';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { getConfig } from '../src/config.js';
import { closeDb, databasePath, getLeaderboard, getProfile, openDb } from '../src/db.js';
import { readBotEnv } from '../src/env.js';
import { rebuildFromGuild } from '../src/rebuild.js';
import { syncAllMembers } from '../src/roles.js';
import { formatNumber } from '../src/util.js';

const argDays = process.argv.indexOf('--days');
const days = Number(argDays > -1 ? process.argv[argDays + 1] : process.env.REBUILD_DAYS || 90);
if (!Number.isFinite(days) || days <= 0) {
  console.error('--days must be a positive number');
  process.exit(1);
}

const env = readBotEnv();
getConfig(); // fail fast on a broken config

/** Move the current database aside (never delete it) so the rebuild starts from zero. */
function setAsideOldDatabase() {
  const file = databasePath();
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const kept = file.replace(/\.db$/, '') + `.before-rebuild-${stamp}.db`;
  fs.renameSync(file, kept);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(file + ext)) fs.renameSync(file + ext, kept + ext);
  console.log(`Old database kept as ${kept}`);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async () => {
  // Only touch the database once we know the login worked.
  try {
    setAsideOldDatabase();
  } catch (err) {
    console.error(`Couldn't move the old database (${err.message}). Is the bot still running? Stop it and try again.`);
    await client.destroy();
    process.exit(1);
  }
  openDb();

  try {
    const guild = await client.guilds.fetch(env.guildId);
    await guild.channels.fetch();
    console.log(`Rebuilding XP for ${guild.name} from the last ${days} days of reactions. This can take a few minutes...`);

    const started = Date.now();
    const s = await rebuildFromGuild(guild, { days });
    console.log(
      `\nScanned ${formatNumber(s.messages)} messages in ${s.channels} channels/threads. ` +
        `${formatNumber(s.grants)} reaction grants + ${formatNumber(s.bonuses)} thread bonuses + ${formatNumber(s.posts)} post bonuses ` +
        `(${Math.round((Date.now() - started) / 1000)}s).`,
    );

    console.log('\nTop 10:');
    getLeaderboard(0, 10).forEach((row, i) => {
      const p = getProfile(row.user_id);
      console.log(`  ${String(i + 1).padStart(2)}. ${(row.username ?? row.user_id).padEnd(20)} ${String(row.rating).padStart(2)} OVR  ${formatNumber(row.xp).padStart(7)} XP  ${p.reactionsReceived} reactions`);
    });

    if (process.env.REBUILD_SKIP_ROLES !== '1') {
      console.log('\nUpdating tier roles...');
      console.log('(Discord rate-limits role changes, so big servers take a while. The XP is already saved.)');
      const r = await syncAllMembers(guild, {
        onProgress: ({ checked, total, changed }) => console.log(`  roles: ${checked}/${total} members checked, ${changed} updated`),
      });
      console.log(`Checked ${r.checked} members, changed ${r.changed}${r.failed ? `, ${r.failed} failed` : ''}.`);
    }
    console.log('\nDone. Start the bot normally again.');
  } catch (err) {
    console.error('Rebuild failed:', err);
    process.exitCode = 1;
  } finally {
    closeDb();
    await client.destroy();
    process.exit();
  }
});

client.login(env.token).catch(async (err) => {
  console.error(`Login failed: ${err.message}`);
  await client.destroy();
  process.exitCode = 1;
});
