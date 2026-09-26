// /card [user] — FC-style player card image (embed fallback if rendering fails).
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildCardEmbed, renderCardAttachment } from '../card/index.js';

export default {
  data: new SlashCommandBuilder()
    .setName('card')
    .setDescription('Show an FC-style player card')
    .addUserOption((o) => o.setName('user').setDescription('Whose card (defaults to yours)')),

  async execute(interaction) {
    const user = interaction.options.getUser('user') ?? interaction.user;
    if (user.bot) {
      await interaction.reply({ content: "Bots don't get cards.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply();
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const card = await renderCardAttachment({ user, member, guild: interaction.guild });
    if (card) await interaction.editReply({ files: [card] });
    else await interaction.editReply({ embeds: [buildCardEmbed({ user, member })] });
  },
};
