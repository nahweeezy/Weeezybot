import { PermissionFlagsBits } from 'discord.js';
import { getConfig } from './config.js';

/** Admin = has the configured admin role, or (if allowed) Discord's Administrator permission. */
export function isAdmin(member, cfg = getConfig()) {
  if (!member?.roles) return false;
  if (cfg.allowDiscordAdministrators && member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  return Boolean(cfg.adminRoleId) && member.roles.cache.has(cfg.adminRoleId);
}
