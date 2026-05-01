# Mandarake First-Listing Scraper

Simple Node.js scraper that checks Mandarake's Manga Magazine listing page once per minute and sends a Pushover notification when the top (first) listing changes.

Files added:
- [package.json](package.json)
- [index.js](index.js)
- [.env.example](.env.example)

Setup

1. Copy `.env.example` to `.env` and fill in your Pushover credentials:

```bash
cp .env.example .env
# edit .env and set PUSHOVER_USER and PUSHOVER_TOKEN
```

2. Install dependencies and run:

```bash
npm install
npm start
```

Notes
- The script stores the last first-listing in `last_listing.json` in the project folder.
- To run on boot on Raspberry Pi OS, create a `systemd` service that runs `npm start` in this folder, or use `pm2`.
