// Prints the full rating -> XP table from config.json so you can review the curve before launch.
//   npm run xp-table            human-readable table
//   npm run xp-table -- --json  a ready-to-paste "table" object for rating.curve.table
import { getConfig } from '../src/config.js';
import { formatXpTable } from '../src/rating.js';

const cfg = getConfig();
const { text, warnings, thresholds } = formatXpTable(cfg);

if (process.argv.includes('--json')) {
  const table = Object.fromEntries(thresholds.map((xp, i) => [String(cfg.rating.min + i), xp]));
  console.log(JSON.stringify(table, null, 2));
} else {
  console.log(`Rating curve from config.json (type: ${cfg.rating.curve.type})\n`);
  console.log(text);
  console.log('\n◄ = first rating of a new tier. "Top-emoji grants" = reactions needed if every one were the highest-value emoji.');
  console.log(`Each person can give a member XP at most once every ${cfg.xp.pairCooldownHours}h, so every grant is a separate person-day.`);
  if (warnings.length) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
}
