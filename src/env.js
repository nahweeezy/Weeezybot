// Loads .env (if present) before anything reads process.env. Imported first by config.js.
// On hosts that inject environment variables directly, the .env file is simply absent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

/** The server this bot runs in. Every event from other servers is ignored. */
export function guildId() {
  return process.env.GUILD_ID;
}

/** Environment the bot needs to start; throws a readable error if something is missing. */
export function readBotEnv() {
  const missing = ['DISCORD_TOKEN', 'GUILD_ID'].filter((key) => !process.env[key]);
  if (missing.length) {
    // Point at the likely mistake: no .env at all, or one saved under a slightly different name.
    const dir = path.dirname(envFile);
    const lookalikes = fs.readdirSync(dir).filter((f) => /env/i.test(f) && f !== '.env' && f !== '.env.example');
    const where = fs.existsSync(envFile)
      ? `${envFile} exists but doesn't set them`
      : `no file at ${envFile}${lookalikes.length ? ` (found ${lookalikes.join(', ')}: rename it to .env)` : ''}`;
    throw new Error(`Missing environment variable(s): ${missing.join(', ')}. ${where}. Copy .env.example to .env and fill it in.`);
  }
  return { token: process.env.DISCORD_TOKEN, guildId: process.env.GUILD_ID };
}
