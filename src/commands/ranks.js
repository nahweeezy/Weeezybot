// /ranks — the server's top 10 as an image styled like the player cards.
import { AttachmentBuilder, SlashCommandBuilder } from 'discord.js';
import { cleanName, compact, fetchImage } from '../card/index.js';
import { renderRankings } from '../card/rankings.js';
import { getConfig } from '../config.js';
import { getLeaderboard, getProfile } from '../db.js';
import { log } from '../logger.js';
import { tierForRating } from '../rating.js';
import { buildPage } from './leaderboard.js';

const TOP = 10;

export default {
  data: new SlashCommandBuilder().setName('ranks').setDescription(`Top ${TOP} players in the server, as a card-style table`),

  async execute(interaction) {
    const cfg = getConfig();
    const top = getLeaderboard(0, TOP);
    if (!top.length) {
      await interaction.reply({ content: 'Nobody has earned XP yet. Go react to some pulls! 🔥' });
      return;
    }
    await interaction.deferReply();
    const guild = interaction.guild;

    try {
      const rows = await Promise.all(
        top.map(async (row, i) => {
          const member = await guild.members.fetch(row.user_id).catch(() => null);
          const profile = getProfile(row.user_id);
          return {
            position: i + 1,
            name: cleanName(member?.displayName ?? row.username ?? 'Unknown'),
            rating: row.rating,
            tier: tierForRating(row.rating, cfg),
            avatar: member ? await fetchImage(member.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true })) : null,
            stats: {
              xp: compact(profile.xp),
              reactions: compact(profile.reactionsReceived),
              fans: compact(profile.uniqueReactors),
              hot: compact(profile.hotReactions),
            },
          };
        }),
      );
      const png = await renderRankings({
        serverName: guild.name,
        badge: await fetchImage(guild.iconURL({ extension: 'png', size: 128, forceStatic: true })),
        subtitle: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        rows,
      });
      await interaction.editReply({ files: [new AttachmentBuilder(png, { name: 'ranks.png' })] });
    } catch (err) {
      // Image failed: fall back to the text leaderboard so the command still answers.
      log.warn(`/ranks render failed: ${err.message}`);
      await interaction.editReply(buildPage(1, interaction.user.id));
    }
  },
};
