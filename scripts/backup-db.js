// Makes a consistent copy of the SQLite database. Safe to run while the bot is online.
//   npm run backup                       -> ./backups/weeezybot-<timestamp>.db
//   npm run backup -- /path/to/file.db
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/config.js';
import { backupDb, closeDb, databasePath } from '../src/db.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const destination = path.resolve(process.argv[2] || path.join(ROOT_DIR, 'backups', `weeezybot-${stamp}.db`));

if (!fs.existsSync(databasePath())) {
  console.error(`No database at ${databasePath()} yet.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(destination), { recursive: true });
await backupDb(destination);
closeDb();
console.log(`Backed up to ${destination}`);
