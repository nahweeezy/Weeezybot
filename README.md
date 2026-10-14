# weeezybot

discord bot for my server. reactions give xp. xp turns into an fc rating from 45 to 99. 🔥 counts more.

![cards](docs/card-tiers.png)

## setup

needs node 22 or newer.

turn on server members and message content intents in the dev portal.

```
npm install
cp .env.example .env
npm run invite
npm start
```

fill in .env first. then use /config in discord to set channels.

settings are in config.json. `npm run xp-table` shows the rating curve.

/ranks shows the top 10. it posts a recap of the most reacted posts every sunday.

on a host set `CONFIG_PATH=data/config.json` in .env. that way your settings dont clash with git pulls.
