// Minimal timestamped logger. Set DEBUG=1 in the environment to see debug lines.
const stamp = () => new Date().toISOString();

export const log = {
  debug: (...args) => {
    if (process.env.DEBUG) console.log(stamp(), 'DEBUG', ...args);
  },
  info: (...args) => console.log(stamp(), 'INFO ', ...args),
  warn: (...args) => console.warn(stamp(), 'WARN ', ...args),
  error: (...args) => console.error(stamp(), 'ERROR', ...args),
};
