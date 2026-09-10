# WhatsApp Pairing-Code Bot (Baileys)

A minimal WhatsApp bot built on [Baileys](https://github.com/WhiskeySockets/Baileys) that:

- Logs in using an **8-digit pairing code** (no QR scanning) — you enter your phone
  number in the console and type the code into WhatsApp > Linked Devices.
- Persists your session to `./auth_info/` (`creds.json` + signal key files), so it
  reconnects automatically on restart without pairing again.
- Auto-reconnects on any dropped connection, unless WhatsApp reports an actual
  logout (in which case it wipes the local session so you can re-pair cleanly).
- Sends a "✅ Connected successfully" message to your own WhatsApp chat once online.
- Responds to two commands, both using the `.` prefix:
  - `.menu` — lists available commands
  - `.ping` — replies with round-trip latency and bot uptime
- Logs every connection step (connecting, open, close reason, creds saved, etc.)
  to the console so it's easy to follow what's happening in the Pterodactyl console.

## Files

- `index.js` — the bot
- `package.json` — dependencies (Baileys pulled straight from GitHub, since the
  npm registry copy can lag behind)
- `auth_info/` — created automatically on first run, holds your session (never commit this)

## Running locally

```bash
npm install
npm start
```

The first time you run it, the console will prompt:

```
Enter your WhatsApp number with country code, digits only (e.g. 15551234567):
```

Enter it, wait for the 8-character pairing code to print, then in WhatsApp go to
**Settings > Linked Devices > Link a Device > Link with phone number instead**,
and type the code in. The bot will log `Connection opened successfully` and
DM you a confirmation.

## Deploying on Pterodactyl

1. Create a server using the **Node.js** egg (Node 20+).
2. Upload/extract this project into the server's file manager (or push it via SFTP),
   *excluding* `node_modules` and `auth_info` — those get created on the server.
3. Set the **Startup Command** to:
   ```
   node index.js
   ```
4. Start the server once to let it run `npm install` (Pterodactyl's Node egg
   normally runs this automatically before start; if not, open the server
   console and run `npm install` manually from the file manager's console).
5. Start the server and open the **Console** tab — this is your interactive
   terminal, so when it asks for your phone number, type it directly into the
   Pterodactyl console input and press enter.
6. Copy the pairing code that prints and enter it into WhatsApp as described above.
7. Once connected, `auth_info/` will persist across restarts as long as the
   server's volume isn't wiped — so future restarts reconnect silently with
   no re-pairing needed.

### Notes for Pterodactyl specifically

- Make sure the egg/container keeps **stdin open** — the Pterodactyl console
  supports typing directly into a running process, so the phone-number prompt
  will work exactly like a normal terminal.
- If you ever get logged out from your phone (Linked Devices > removed), the
  bot detects this, deletes `auth_info/`, and exits — just start it again to
  pair fresh.
- Back up `auth_info/` if you want to preserve the session across server
  re-installs/migrations.

## Extending

Commands live in `handleMessages()` in `index.js` — add more `else if (command === '...')`
branches following the pattern used by `.menu` and `.ping`.
