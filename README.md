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
