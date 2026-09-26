// Routes slash commands, autocomplete and buttons to the command modules.
import { MessageFlags } from 'discord.js';
import card from './commands/card.js';
import config from './commands/config.js';
import leaderboard from './commands/leaderboard.js';
import xp from './commands/xp.js';
import { closeThreadButton } from './autothread.js';
import { guildId } from './env.js';
import { log } from './logger.js';
import { isAdmin } from './permissions.js';

const commandList = [card, leaderboard, xp, config];
const commands = new Map(commandList.map((c) => [c.data.name, c]));

/** JSON definitions to register with Discord. */
export const commandDefinitions = commandList.map((c) => c.data.toJSON());

export async function handleInteraction(interaction) {
  if (!interaction.inGuild() || interaction.guildId !== guildId()) return;

  if (interaction.isAutocomplete()) {
    const command = commands.get(interaction.commandName);
    // Autocomplete leaks config paths, so only answer admins for admin commands.
    if (!command?.autocomplete || (command.adminOnly && !isAdmin(interaction.member))) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    await command.autocomplete(interaction).catch((err) => log.debug('autocomplete failed:', err.message));
    return;
  }

  if (interaction.isButton()) {
    const command = [...commandList, closeThreadButton].find((c) => c.buttonPrefix && interaction.customId.startsWith(c.buttonPrefix));
    if (command) await command.handleButton(interaction).catch((err) => log.warn('button failed:', err.message));
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) return;

  if (command.adminOnly && !isAdmin(interaction.member)) {
    await interaction.reply({ content: '🔒 Admins only.', flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    log.error(`/${interaction.commandName} failed:`, err);
    const payload = { content: `Something went wrong: ${err.message}`.slice(0, 2000), flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
}
