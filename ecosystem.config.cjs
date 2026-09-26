// pm2 process file:  pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'weeezybot',
      script: 'src/index.js',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 50,
      // The bot needs a few seconds on shutdown to save pending XP and post pending rank-ups.
      kill_timeout: 8000,
    },
  ],
};
