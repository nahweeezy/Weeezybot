// Prints the invite URL with exactly the permissions the bot needs.
//   npm run invite            (uses CLIENT_ID from .env)
//   npm run invite -- 1234567890123456789
import '../src/env.js';
import { OAuth2Scopes, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

const clientId = process.argv[2] || process.env.CLIENT_ID;
if (!clientId) {
  console.error('Set CLIENT_ID in .env (Developer Portal → your app → General Information → Application ID), or pass it as an argument.');
  process.exit(1);
}

const needed = {
  ViewChannel: 'see channels and read messages',
  SendMessages: 'post rank-up announcements',
  SendMessagesInThreads: 'work inside threads',
  CreatePublicThreads: 'auto-threads on media posts',
  EmbedLinks: 'embeds (cards, leaderboard, promotions)',
  AttachFiles: 'card images',
  ReadMessageHistory: 'see reactions on older messages',
  AddReactions: 'the 🔥 on posts that get an auto-thread',
  ManageMessages: 'delete text-only posts in media-only channels',
  ManageRoles: 'assign tier roles, lock the rank-up channel',
  ManageChannels: 'set slow mode, lock the rank-up channel',
  ManageThreads: 'lock threads closed with the close button (only if closeButton.lock is on)',
};

const permissions = new PermissionsBitField(Object.keys(needed).map((name) => PermissionFlagsBits[name]));
const url = new URL('https://discord.com/oauth2/authorize');
url.searchParams.set('client_id', clientId);
url.searchParams.set('scope', [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join(' '));
url.searchParams.set('permissions', permissions.bitfield.toString());

console.log('Permissions requested:');
for (const [name, why] of Object.entries(needed)) console.log(`  • ${name.padEnd(22)} ${why}`);
console.log(`\nPermission integer: ${permissions.bitfield}\n\nInvite link:\n${url}\n`);
