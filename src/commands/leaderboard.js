// /leaderboard [page] — top members by XP with ◀ ▶ page buttons.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getConfig } from '../config.js';
import { countRanked, getLeaderboard, getProfile } from '../db.js';
import { tierForRating } from '../rating.js';
import { formatNumber } from '../util.js';

const MEDALS = ['🥇', '🥈', '🥉'];

/** Button IDs look like "lb:<ownerId>:<page>" so the buttons work without any stored state. */
function buildPage(requestedPage, ownerId) {
  const cfg = getConfig();
  const size = cfg.leaderboard.pageSize;
  const total = countRanked();
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, requestedPage), pages);

  const rows = getLeaderboard((page - 1) * size, size);
  const lines = rows.map((row, i) => {
    const position = (page - 1) * size + i + 1;
    const tier = tierForRating(row.rating, cfg);
    const label = MEDALS[position - 1] ?? `**${position}.**`;
    return `${label} <@${row.user_id}> · **${row.rating}** OVR ${tier.emoji} · ${formatNumber(row.xp)} XP`;
  });

  const mine = getProfile(ownerId);
  const embed = new EmbedBuilder()
    .setTitle('🏆 Leaderboard')
    .setColor(tierForRating(rows[0]?.rating ?? cfg.rating.min, cfg).color)
    .setDescription(lines.join('\n') || 'Nobody has earned XP yet. Go react to some pulls! 🔥')
    .setFooter({
      text: `Page ${page}/${pages} · ${formatNumber(total)} ranked · You: ${mine.rank ? `#${formatNumber(mine.rank)}` : 'unranked'} (${mine.rating} OVR)`,
    });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lb:${ownerId}:${page - 1}`)
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`lb:${ownerId}:${page + 1}`)
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages),
  );
  return { embeds: [embed], components: pages > 1 ? [buttons] : [] };
}

export default {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top members by XP')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),

  async execute(interaction) {
    await interaction.reply(buildPage(interaction.options.getInteger('page') ?? 1, interaction.user.id));
  },

  buttonPrefix: 'lb:',

  async handleButton(interaction) {
    const [, ownerId, page] = interaction.customId.split(':');
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: 'Run `/leaderboard` to browse it yourself.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.update(buildPage(Number(page), ownerId));
  },
};
