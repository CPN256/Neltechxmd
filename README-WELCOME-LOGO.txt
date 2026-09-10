# CAT CPN Welcome Logo

Files included:
- `index.js` — updated bot code
- `package.json` — Node.js dependencies/start command
- `assets/logo.png` — CAT CPN logo shown with the connected welcome message

## GitHub/Pterodactyl setup

1. Upload `index.js` to the repository root and replace the old one.
2. Upload the `assets` folder and make sure the image is exactly:
   `assets/logo.png`
3. Keep `package.json` in the repository root.
4. On Pterodactyl, start the bot with:
   `node index.js`

The bot checks for `assets/logo.png`. If it exists, the connected welcome message is sent as an image with the welcome caption. If the image is missing, it falls back to a text-only welcome message.

Important: keep the filename and folder name exactly as shown.
