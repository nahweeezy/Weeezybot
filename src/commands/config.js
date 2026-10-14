// /config — admin editing of config.json from Discord. Every change is validated before it is
// saved; an invalid change is rejected and nothing is written.
import { AttachmentBuilder, ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { applySlowmodes, autothreadSettings } from '../autothread.js';
import { CONFIG_PATH, getConfig, reloadConfig, updateConfig } from '../config.js';
import { ConfigError } from '../configSchema.js';
import { normalizeEmoji } from '../emoji.js';
import { formatXpTable } from '../rating.js';
import { postRecap } from '../recap.js';
import { syncAllMembers } from '../roles.js';
import { formatNumber } from '../util.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };

const ARCHIVE_CHOICES = [
  { name: '1 hour', value: 60 },
  { name: '24 hours', value: 1440 },
  { name: '3 days', value: 4320 },
  { name: '1 week', value: 10080 },
];

// ---------------------------------------------------------------------------
// Dotted-path helpers for /config set  (e.g. "xp.pairCooldownHours", "tiers.2.name")
// ---------------------------------------------------------------------------

/** Every editable path in the config: leaves, plus containers so whole lists/objects can be replaced. */
function listPaths(value, prefix = '') {
  if (Array.isArray(value)) {
    const nested = value.some((v) => v && typeof v === 'object');
    return nested ? [prefix, ...value.flatMap((v, i) => listPaths(v, `${prefix}.${i}`))] : [prefix];
  }
  if (value && typeof value === 'object') {
    const children = Object.keys(value).flatMap((k) => listPaths(value[k], prefix ? `${prefix}.${k}` : k));
    return prefix ? [prefix, ...children] : children;
  }
  return [prefix];
}

function getPath(obj, parts) {
  return parts.reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), obj);
}

function setPath(obj, parts, value) {
  const parent = getPath(obj, parts.slice(0, -1));
  if (!parent || typeof parent !== 'object') throw new ConfigError(`Can't set ${parts.join('.')}: its parent doesn't exist.`);
  parent[parts.at(-1)] = value;
}

/** For keys that don't exist yet, borrow the type from a sensible sibling. */
function typeTemplate(cfg, parts) {
  const current = getPath(cfg, parts);
  if (current !== undefined) return current;
  if (parts[0] === 'autothread' && parts[1] === 'channels' && parts.length === 4) return cfg.autothread.defaults[parts[3]];
  if (parts[0] === 'xp' && parts[1] === 'emojiValues' && parts.length === 3) return 0;
  return undefined;
}

const MENTION_ID_RE = /^<(?:#|@&|@!?)(\d{17,20})>$/;

/** Turn the text typed in Discord into the right JSON type, based on what the key currently holds. */
function parseValue(text, template, key) {
  const t = text.trim();
  if (t === 'null') return null;
  if (template === null) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
    throw new ConfigError('Expected a number or null.');
  }
  switch (typeof template) {
    case 'boolean':
      if (/^(true|yes|on|1)$/i.test(t)) return true;
      if (/^(false|no|off|0)$/i.test(t)) return false;
      throw new ConfigError('Expected true or false.');
    case 'number': {
      const n = Number(t);
      if (!Number.isFinite(n) || t === '') throw new ConfigError('Expected a number.');
      return n;
    }
    case 'string': {
      const mention = t.match(MENTION_ID_RE);
      if (mention) return mention[1];
      if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return JSON.parse(t);
      return t;
    }
    case 'object':
      // ID lists (xp.channels, exemptRoleIds) can be given as mentions: "<#123> <#456>".
      if (Array.isArray(template) && /(ids|channels)$/i.test(key) && !t.startsWith('[')) return t.match(/\d{17,20}/g) ?? [];
      try {
        return JSON.parse(t);
      } catch {
        throw new ConfigError('Expected JSON for this key, e.g. ["123", "456"] or {"key": 1}.');
      }
    default:
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const clip = (text, max = 1024) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const channelList = (ids) => (ids.length ? ids.map((id) => `<#${id}>`).join(' ') : '_none_');

function emojiLabel(key) {
  if (/^\d{17,20}$/.test(key)) return `<:e:${key}>`;
  if (/^\w+$/.test(key)) return `:${key}:`;
  return key;
}

function describeAutothread(id, cfg) {
  const s = autothreadSettings(id, cfg);
  const extras = [`"${s.nameFormat}"`, s.mediaOnly ? 'media-only' : null, s.slowmodeSeconds !== null ? `slow mode ${s.slowmodeSeconds}s` : null];
  return `<#${id}> — ${extras.filter(Boolean).join(' · ')}`;
}

function tierLines(cfg) {
  return cfg.tiers.map((t, i) => {
    const top = cfg.tiers[i + 1] ? cfg.tiers[i + 1].minRating - 1 : cfg.rating.max;
    const range = top === t.minRating ? `${t.minRating}` : `${t.minRating}–${top}`;
    return `${t.emoji} **${t.name}** ${range} → ${t.roleId ? `<@&${t.roleId}>` : '_no role_'}`;
  });
}

/** Warn about permissions the bot is missing in a channel. */
function missingPerms(channel, needed) {
  const perms = channel.permissionsFor(channel.guild.members.me);
  const missing = Object.entries(needed)
    .filter(([, flag]) => !perms?.has(flag))
    .map(([name]) => name);
  return missing.length ? `\n⚠️ The bot is missing **${missing.join(', ')}** in <#${channel.id}>.` : '';
}

async function respond(interaction, payload) {
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else await interaction.reply({ ...EPHEMERAL, ...payload });
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

const handlers = {
  async show(i) {
    const cfg = getConfig();
    const rc = cfg.rankup;
    const emojis = Object.entries(cfg.xp.emojiValues).map(([k, v]) => `${emojiLabel(k)} ${v} XP`);
    emojis.push(`anything else ${cfg.xp.defaultEmojiXp} XP`);
    const autothreads = Object.keys(cfg.autothread.channels).map((id) => describeAutothread(id, cfg));

    const embed = new EmbedBuilder()
      .setTitle('⚙️ Bot settings')
      .setColor(cfg.tiers[0].color)
      .addFields(
        { name: 'Admin role', value: cfg.adminRoleId ? `<@&${cfg.adminRoleId}>` : '_not set (Discord admins only)_', inline: true },
        {
          name: 'Rank-up channel',
          value: `${rc.channelId ? `<#${rc.channelId}>` : '_not set_'}\nping bumps: ${rc.pingOnBump ? 'on' : 'off'} · promotions: ${rc.pingOnPromotion ? 'on' : 'off'}`,
          inline: true,
        },
        {
          name: 'XP channels',
          value: clip(`${channelList(cfg.xp.channels)}${cfg.xp.includeAutothreadChannels ? '\n+ every auto-thread channel' : ''}\n(threads & forum posts inside them count too)`),
        },
        {
          name: 'XP rules',
          value: clip(
            `${emojis.join(' · ')}\nOne grant per giver → receiver every **${cfg.xp.pairCooldownHours}h**` +
              `${cfg.xp.oncePerMessage ? ' · max one grant per message per giver' : ''}`,
          ),
        },
        { name: 'Auto-thread channels', value: clip(autothreads.join('\n') || '_none_') },
        { name: 'Tiers', value: clip(tierLines(cfg).join('\n')) },
      )
      .setFooter({ text: `Full config attached · ${CONFIG_PATH}`.slice(0, 2048) });

    const file = new AttachmentBuilder(Buffer.from(JSON.stringify(cfg, null, 2)), { name: 'config.json' });
    await respond(i, { embeds: [embed], files: [file] });
  },

  async reload(i) {
    reloadConfig();
    await respond(i, { content: '✅ Reloaded config.json from disk.' });
  },

  async set(i) {
    const key = i.options.getString('key', true).trim();
    const parts = key.split('.');
    const cfg = getConfig();
    const template = typeTemplate(cfg, parts);
    if (template === undefined && getPath(cfg, parts.slice(0, -1)) === undefined) {
      await respond(i, { content: `❌ Unknown setting \`${key}\`. Start typing to see the available keys.` });
      return;
    }
    const value = parseValue(i.options.getString('value', true), template, parts.at(-1));
    updateConfig((draft) => setPath(draft, parts, value));
    await respond(i, { content: `✅ \`${key}\` = \`${clip(JSON.stringify(value), 1800)}\`` });
  },

  async curve(i) {
    const cfg = getConfig();
    const { text, warnings, thresholds } = formatXpTable(cfg);
    const at = (r) => formatNumber(thresholds[r - cfg.rating.min]);
    const marks = cfg.tiers.slice(1).map((t) => `${t.minRating}: ${at(t.minRating)} XP`);
    const file = new AttachmentBuilder(Buffer.from(text), { name: 'xp-table.txt' });
    const warn = warnings.length ? `\n⚠️ ${warnings.join('\n⚠️ ')}` : '';
    await respond(i, { content: `**Rating curve** (${cfg.rating.curve.type}) · ${marks.join(' · ')}${warn}`.slice(0, 2000), files: [file] });
  },

  async 'admin-role'(i) {
    const role = i.options.getRole('role', true);
    updateConfig((d) => {
      d.adminRoleId = role.id;
    });
    await respond(i, { content: `✅ Admin commands are now available to <@&${role.id}>.` });
  },

  async 'rankup-channel'(i) {
    const channel = i.options.getChannel('channel', true);
    updateConfig((d) => {
      d.rankup.channelId = channel.id;
    });
    let note = '';
    if (i.options.getBoolean('lock')) {
      const reason = 'Rank-up channel: bot posts only';
      await channel.permissionOverwrites.edit(
        i.guild.roles.everyone,
        { SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false, CreatePrivateThreads: false, AddReactions: true },
        { reason },
      );
      await channel.permissionOverwrites.edit(
        i.guild.members.me.id,
        { ViewChannel: true, SendMessages: true, EmbedLinks: true, AttachFiles: true, ReadMessageHistory: true },
        { reason },
      );
      note = '\n🔒 Locked: members can read and react, only the bot can post.';
    }
    note += missingPerms(channel, {
      'View Channel': PermissionFlagsBits.ViewChannel,
      'Send Messages': PermissionFlagsBits.SendMessages,
      'Embed Links': PermissionFlagsBits.EmbedLinks,
      'Attach Files': PermissionFlagsBits.AttachFiles,
    });
    await respond(i, { content: `✅ Rank-ups will be posted in <#${channel.id}>.${note}` });
  },

  async 'tier-role'(i) {
    const key = i.options.getString('tier', true);
    const role = i.options.getRole('role', true);
    const tier = getConfig().tiers.find((t) => t.key === key);
    if (!tier) {
      await respond(i, { content: `❌ No tier with key \`${key}\`.` });
      return;
    }
    if (role.managed || role.id === i.guild.id) {
      await respond(i, { content: "❌ That role can't be assigned (it's managed by an integration or @everyone)." });
      return;
    }
    updateConfig((d) => {
      d.tiers.find((t) => t.key === key).roleId = role.id;
    });
    const warn = role.editable ? '' : "\n⚠️ The bot's role is below this role, so it can't assign it yet. Move the bot's role higher.";
    await respond(i, { content: `✅ ${tier.name} → <@&${role.id}>. Run \`/config sync-roles\` to move existing members over.${warn}` });
  },

  async 'sync-roles'(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const { checked, changed, failed } = await syncAllMembers(i.guild);
    await i.editReply({
      content: `✅ Checked ${formatNumber(checked)} members, updated ${formatNumber(changed)}${failed ? `, ${failed} failed (see logs)` : ''}.`,
    });
  },

  async 'xpchannels.add'(i) {
    const channel = i.options.getChannel('channel', true);
    updateConfig((d) => {
      if (!d.xp.channels.includes(channel.id)) d.xp.channels.push(channel.id);
    });
    await respond(i, { content: `✅ Reactions in <#${channel.id}> (and its threads/posts) now earn XP.` });
  },

  async 'xpchannels.remove'(i) {
    const channel = i.options.getChannel('channel', true);
    const cfg = getConfig();
    if (!cfg.xp.channels.includes(channel.id)) {
      const viaAutothread = cfg.xp.includeAutothreadChannels && cfg.autothread.channels[channel.id];
      await respond(i, {
        content: viaAutothread
          ? `<#${channel.id}> earns XP because it's an auto-thread channel. Set \`xp.includeAutothreadChannels\` to false or remove the auto-thread to stop it.`
          : `<#${channel.id}> isn't an XP channel.`,
      });
      return;
    }
    updateConfig((d) => {
      d.xp.channels = d.xp.channels.filter((id) => id !== channel.id);
    });
    await respond(i, { content: `✅ <#${channel.id}> no longer earns XP.` });
  },

  async 'xpchannels.list'(i) {
    const cfg = getConfig();
    const auto = Object.keys(cfg.autothread.channels);
    const lines = [`**XP channels:** ${channelList(cfg.xp.channels)}`];
    if (cfg.xp.includeAutothreadChannels) lines.push(`**Via auto-threads:** ${channelList(auto)}`);
    lines.push('Threads and forum posts inside these count too.');
    await respond(i, { content: clip(lines.join('\n'), 2000) });
  },

  async 'autothread.add'(i) {
    const channel = i.options.getChannel('channel', true);
    const changes = {};
    const nameFormat = i.options.getString('name_format');
    const mediaOnly = i.options.getBoolean('media_only');
    const slowmode = i.options.getInteger('slowmode');
    const archive = i.options.getInteger('archive_after');
    if (nameFormat !== null) changes.nameFormat = nameFormat;
    if (mediaOnly !== null) changes.mediaOnly = mediaOnly;
    if (slowmode !== null) changes.slowmodeSeconds = slowmode;
    if (archive !== null) changes.autoArchiveMinutes = archive;

    const existed = Boolean(getConfig().autothread.channels[channel.id]);
    updateConfig((d) => {
      d.autothread.channels[channel.id] = { ...(d.autothread.channels[channel.id] ?? {}), ...changes };
    });
    await applySlowmodes(i.guild);

    const s = autothreadSettings(channel.id);
    const needed = {
      'Create Public Threads': PermissionFlagsBits.CreatePublicThreads,
      'Send Messages in Threads': PermissionFlagsBits.SendMessagesInThreads,
    };
    if (s.mediaOnly) needed['Manage Messages'] = PermissionFlagsBits.ManageMessages;
    if (s.slowmodeSeconds !== null) needed['Manage Channels'] = PermissionFlagsBits.ManageChannels;
    await respond(i, { content: `✅ ${existed ? 'Updated' : 'Enabled'} auto-threads: ${describeAutothread(channel.id, getConfig())}${missingPerms(channel, needed)}` });
  },

  async 'autothread.mediaonly'(i) {
    const channel = i.options.getChannel('channel', true);
    const enabled = i.options.getBoolean('enabled', true);
    updateConfig((d) => {
      d.autothread.channels[channel.id] = { ...(d.autothread.channels[channel.id] ?? {}), mediaOnly: enabled };
    });
    const warn = enabled ? missingPerms(channel, { 'Manage Messages': PermissionFlagsBits.ManageMessages }) : '';
    await respond(i, {
      content: enabled
        ? `✅ <#${channel.id}> is now media-only. Text-only messages get deleted with a short notice.${warn}`
        : `✅ Media-only mode is off in <#${channel.id}>.`,
    });
  },

  async 'recap-channel'(i) {
    const channel = i.options.getChannel('channel', true);
    updateConfig((d) => {
      d.recap.channelId = channel.id;
      d.recap.enabled = true;
    });
    const rc = getConfig().recap;
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][rc.dayOfWeek];
    const time = `${String(rc.hour).padStart(2, '0')}:${String(rc.minute).padStart(2, '0')}${rc.timezone ? ` ${rc.timezone}` : ' (bot host time)'}`;
    const warn = missingPerms(channel, {
      'Send Messages': PermissionFlagsBits.SendMessages,
      'Embed Links': PermissionFlagsBits.EmbedLinks,
    });
    await respond(i, { content: `✅ The weekly recap will be posted in <#${channel.id}> every ${day} at ${time}. Try it now with \`/config recap-now\`.${warn}` });
  },

  async 'recap-now'(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const status = await postRecap(i.guild);
    await i.editReply({ content: `Recap: ${status}.` });
  },

  async 'autothread.remove'(i) {
    const channel = i.options.getChannel('channel', true);
    if (!getConfig().autothread.channels[channel.id]) {
      await respond(i, { content: `<#${channel.id}> doesn't have auto-threads.` });
      return;
    }
    updateConfig((d) => {
      delete d.autothread.channels[channel.id];
    });
    await respond(i, { content: `✅ Auto-threads disabled in <#${channel.id}>. (Its slow mode, if any, was left as is.)` });
  },

  async 'autothread.list'(i) {
    const cfg = getConfig();
    const lines = Object.keys(cfg.autothread.channels).map((id) => describeAutothread(id, cfg));
    await respond(i, { content: clip(lines.length ? `**Auto-thread channels**\n${lines.join('\n')}` : 'No auto-thread channels yet.', 2000) });
  },

  async 'emoji.set'(i) {
    const key = normalizeEmoji(i.options.getString('emoji', true));
    const xp = i.options.getInteger('xp', true);
    if (!key || key.length > 64) {
      await respond(i, { content: '❌ Give a single emoji (or a custom emoji from this server).' });
      return;
    }
    updateConfig((d) => {
      for (const k of Object.keys(d.xp.emojiValues)) if (normalizeEmoji(k) === key) delete d.xp.emojiValues[k];
      d.xp.emojiValues[key] = xp;
    });
    await respond(i, { content: `✅ ${emojiLabel(key)} reactions are now worth **${xp} XP**.` });
  },

  async 'emoji.remove'(i) {
    const key = normalizeEmoji(i.options.getString('emoji', true));
    const cfg = getConfig();
    if (!Object.keys(cfg.xp.emojiValues).some((k) => normalizeEmoji(k) === key)) {
      await respond(i, { content: `${emojiLabel(key)} has no custom value.` });
      return;
    }
    updateConfig((d) => {
      for (const k of Object.keys(d.xp.emojiValues)) if (normalizeEmoji(k) === key) delete d.xp.emojiValues[k];
    });
    await respond(i, { content: `✅ ${emojiLabel(key)} is back to the default (${cfg.xp.defaultEmojiXp} XP).` });
  },

  async 'emoji.list'(i) {
    const cfg = getConfig();
    const lines = Object.entries(cfg.xp.emojiValues).map(([k, v]) => `${emojiLabel(k)} → ${v} XP`);
    lines.push(`Any other emoji → ${cfg.xp.defaultEmojiXp} XP`);
    await respond(i, { content: lines.join('\n') });
  },
};

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export default {
  adminOnly: true,

  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Admin: bot settings')
    .addSubcommand((s) => s.setName('show').setDescription('Show the current settings (full config attached)'))
    .addSubcommand((s) => s.setName('reload').setDescription('Re-read config.json after editing the file by hand'))
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Change any setting by its config.json path')
        .addStringOption((o) => o.setName('key').setDescription('e.g. xp.pairCooldownHours').setRequired(true).setAutocomplete(true))
        .addStringOption((o) =>
          o.setName('value').setDescription('New value (JSON for lists/objects, null to clear)').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) => s.setName('curve').setDescription('Show the full rating → XP table'))
    .addSubcommand((s) =>
      s
        .setName('admin-role')
        .setDescription('Set the role allowed to use admin commands')
        .addRoleOption((o) => o.setName('role').setDescription('Admin role').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('rankup-channel')
        .setDescription('Set the rank-up announcement channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
        .addBooleanOption((o) => o.setName('lock').setDescription('Also make it bot-post-only (members can still react)')),
    )
    .addSubcommand((s) =>
      s
        .setName('tier-role')
        .setDescription('Use an existing role for a tier')
        .addStringOption((o) => o.setName('tier').setDescription('Tier').setRequired(true).setAutocomplete(true))
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('sync-roles').setDescription('Give every member the right tier role (slow on big servers)'))
    .addSubcommand((s) =>
      s
        .setName('recap-channel')
        .setDescription('Set where the weekly recap of the most-reacted posts goes')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel, e.g. #general').setRequired(true).addChannelTypes(...TEXT_CHANNELS)),
    )
    .addSubcommand((s) => s.setName('recap-now').setDescription('Post the weekly recap right now (for testing)'))
    .addSubcommandGroup((g) =>
      g
        .setName('xpchannels')
        .setDescription('Channels where reactions earn XP')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Reactions here (and in its threads/posts) earn XP')
            .addChannelOption((o) =>
              o
                .setName('channel')
                .setDescription('Text/forum channel or whole category')
                .setRequired(true)
                .addChannelTypes(...TEXT_CHANNELS, ChannelType.GuildForum, ChannelType.GuildMedia, ChannelType.GuildCategory),
            ),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Stop reactions here from earning XP')
            .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)),
        )
        .addSubcommand((s) => s.setName('list').setDescription('List XP channels')),
    )
    .addSubcommandGroup((g) =>
      g
        .setName('autothread')
        .setDescription('Media channels that get automatic threads')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Enable auto-threads in a channel, or update its settings')
            .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
            .addStringOption((o) =>
              o.setName('name_format').setDescription("Thread name, e.g. {displayName}'s pull ({username}, {channel} work too)").setMaxLength(100),
            )
            .addBooleanOption((o) => o.setName('media_only').setDescription('Delete text-only messages and DM the author a note'))
            .addIntegerOption((o) => o.setName('slowmode').setDescription('Slow mode in seconds (0 = off)').setMinValue(0).setMaxValue(21600))
            .addIntegerOption((o) => o.setName('archive_after').setDescription('Archive threads after inactivity').addChoices(...ARCHIVE_CHOICES)),
        )
        .addSubcommand((s) =>
          s
            .setName('mediaonly')
            .setDescription('Turn media-only mode on or off (text-only messages get deleted)')
            .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
            .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Disable auto-threads in a channel')
            .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)),
        )
        .addSubcommand((s) => s.setName('list').setDescription('List auto-thread channels')),
    )
    .addSubcommandGroup((g) =>
      g
        .setName('emoji')
        .setDescription('XP value per emoji')
        .addSubcommand((s) =>
          s
            .setName('set')
            .setDescription('Set how much XP an emoji gives')
            .addStringOption((o) => o.setName('emoji').setDescription('The emoji').setRequired(true))
            .addIntegerOption((o) => o.setName('xp').setDescription('XP per grant').setRequired(true).setMinValue(0).setMaxValue(1000)),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Reset an emoji to the default value')
            .addStringOption((o) => o.setName('emoji').setDescription('The emoji').setRequired(true)),
        )
        .addSubcommand((s) => s.setName('list').setDescription('List emoji XP values')),
    ),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const handler = handlers[group ? `${group}.${sub}` : sub];
    try {
      await handler(interaction);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      await respond(interaction, { content: `❌ Not saved.\n\`\`\`\n${clip(err.message, 1800)}\n\`\`\`` });
    }
  },

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const cfg = getConfig();
    const query = focused.value.toLowerCase();

    if (focused.name === 'key') {
      const paths = listPaths(cfg).filter((p) => p.toLowerCase().includes(query));
      paths.sort((a, b) => Number(!a.toLowerCase().startsWith(query)) - Number(!b.toLowerCase().startsWith(query)));
      await interaction.respond(paths.slice(0, 25).map((p) => ({ name: p.slice(0, 100), value: p.slice(0, 100) })));
    } else if (focused.name === 'value') {
      // Suggest the current value so admins can see (and tweak) it.
      const key = interaction.options.getString('key') ?? '';
      const current = getPath(cfg, key.split('.'));
      const text = current === undefined ? '' : typeof current === 'string' ? current : JSON.stringify(current);
      const choices = [];
      // Choices max out at 100 chars; offering a truncated copy of a long value could get it picked by accident.
      if (focused.value && focused.value.length <= 100) choices.push({ name: focused.value, value: focused.value });
      if (text && text.length <= 100 && text !== focused.value) choices.push({ name: `current: ${text}`.slice(0, 100), value: text });
      await interaction.respond(choices);
    } else if (focused.name === 'tier') {
      const tiers = cfg.tiers.filter((t) => `${t.name} ${t.key}`.toLowerCase().includes(query));
      await interaction.respond(tiers.slice(0, 25).map((t) => ({ name: `${t.name} (${t.minRating}+)`, value: t.key })));
    }
  },
};
