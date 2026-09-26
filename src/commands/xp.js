// /xp add|remove|set|reset|history — admin XP corrections. Every change is logged in xp_events.
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getConfig } from '../config.js';
import { adjustXp, getRecentEvents } from '../db.js';
import { applyRatingChange } from '../progression.js';
import { xpForRating } from '../rating.js';
import { formatNumber } from '../util.js';

const HISTORY_LIMIT = 15;

const userOption = (o) => o.setName('user').setDescription('Member').setRequired(true);
const reasonOption = (o) => o.setName('reason').setDescription('Why (saved in the XP log)').setMaxLength(200);

function describeEvent(e) {
  const amount = `\`${e.amount >= 0 ? '+' : ''}${formatNumber(e.amount)}\``;
  const when = `<t:${Math.floor(e.created_at / 1000)}:R>`;
  if (e.kind === 'thread_bonus') return `${amount} ${e.emoji ?? ''} thread bonus in <#${e.channel_id}> ${when}`;
  if (e.kind === 'reaction') {
    return `${amount} ${e.emoji ?? ''} from <@${e.giver_id}> in <#${e.channel_id}> ${when}`;
  }
  const what = e.kind.replace('admin_', '');
  return `${amount} **${what}** by <@${e.giver_id}>${e.reason ? ` — ${e.reason}` : ''} ${when}`;
}

export default {
  adminOnly: true,

  data: new SlashCommandBuilder()
    .setName('xp')
    .setDescription('Admin: manual XP corrections')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Give a member XP')
        .addUserOption(userOption)
        .addIntegerOption((o) => o.setName('amount').setDescription('XP to add').setRequired(true).setMinValue(1))
        .addStringOption(reasonOption),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Take XP away from a member (never below 0)')
        .addUserOption(userOption)
        .addIntegerOption((o) => o.setName('amount').setDescription('XP to remove').setRequired(true).setMinValue(1))
        .addStringOption(reasonOption),
    )
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription("Set a member's total XP, or put them at the start of a rating")
        .addUserOption(userOption)
        .addIntegerOption((o) => o.setName('amount').setDescription('Exact total XP').setMinValue(0))
        .addIntegerOption((o) => o.setName('rating').setDescription('Or: set XP to the minimum for this rating').setMinValue(1))
        .addStringOption(reasonOption),
    )
    .addSubcommand((s) =>
      s
        .setName('reset')
        .setDescription('Reset a member to 0 XP (starting rating)')
        .addUserOption(userOption)
        .addStringOption(reasonOption),
    )
    .addSubcommand((s) =>
      s.setName('history').setDescription("Show a member's recent XP events").addUserOption(userOption),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user', true);
    const ephemeral = { flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };

    if (user.bot) {
      await interaction.reply({ content: "Bots can't hold XP.", ...ephemeral });
      return;
    }

    if (sub === 'history') {
      const events = getRecentEvents(user.id, HISTORY_LIMIT);
      const body = events.length ? events.map(describeEvent).join('\n') : 'No XP events yet.';
      await interaction.reply({ content: `**Recent XP for <@${user.id}>**\n${body}`.slice(0, 2000), ...ephemeral });
      return;
    }

    const base = {
      receiverId: user.id,
      giverId: interaction.user.id,
      reason: interaction.options.getString('reason'),
      username: user.username,
    };
    let change;
    if (sub === 'add') {
      change = adjustXp({ ...base, kind: 'admin_add', delta: interaction.options.getInteger('amount', true) });
    } else if (sub === 'remove') {
      change = adjustXp({ ...base, kind: 'admin_remove', delta: -interaction.options.getInteger('amount', true) });
    } else if (sub === 'reset') {
      change = adjustXp({ ...base, kind: 'admin_reset', set: 0 });
    } else {
      const amount = interaction.options.getInteger('amount');
      const rating = interaction.options.getInteger('rating');
      const { min, max } = getConfig().rating;
      if ((amount === null) === (rating === null)) {
        await interaction.reply({ content: 'Give either `amount` or `rating` (not both).', ...ephemeral });
        return;
      }
      if (rating !== null && (rating < min || rating > max)) {
        await interaction.reply({ content: `Rating must be between ${min} and ${max}.`, ...ephemeral });
        return;
      }
      change = adjustXp({ ...base, kind: 'admin_set', set: amount ?? xpForRating(rating) });
    }

    const ratingText = change.oldRating === change.newRating ? `${change.newRating} OVR` : `${change.oldRating} → ${change.newRating} OVR`;
    await interaction.reply({
      content: `✅ <@${user.id}>: ${formatNumber(change.oldXp)} → **${formatNumber(change.newXp)} XP** · ${ratingText}`,
      ...ephemeral,
    });
    // Reply first (Discord wants an answer within 3s), then update roles / queue the announcement.
    await applyRatingChange(interaction.guild, change, { manual: true, sourceChannelId: interaction.channelId });
  },
};
