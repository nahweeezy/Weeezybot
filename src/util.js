// Small shared helpers.

/** Fill {placeholders} in a config template. Unknown placeholders are left untouched. */
export function fillTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (vars[key] !== undefined ? String(vars[key]) : match));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function formatNumber(n) {
  return Number(n).toLocaleString('en-US');
}

const chains = new Map();

/**
 * Run async work one-at-a-time per key (e.g. per member) so overlapping updates
 * for the same member can't interleave. Different keys still run in parallel.
 */
export function runExclusive(key, fn) {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  chains.set(key, next);
  const cleanup = () => {
    if (chains.get(key) === next) chains.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}
