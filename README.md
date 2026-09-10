```
DON'T FORGET TO FORK 🍴 & STAR 🌟 OUR REPO🫠
```
---

> **CURRENT BOT VERSION ➜ `1.1.1 ⚡`**
---

<a href="https://git.io/typing-svg">
  <img src="https://readme-typing-svg.demolab.com?font=Black+Ops+One&size=50&pause=1000&color=1BAFBAFF&center=true&width=1200&height=100&lines=HEY%20DEAR%20WELCOME;TOO%20CAT-CPN-V1%20BOT%20REPO;MULTI%20DEVICE%20WHATSAPP%20BOT;CREATED%20BY%20CatCpntech" alt="Typing SVG" />
</a>


<p align="center">
  <a href="https://chat.whatsapp.com/KMvJBu444hzEiAhzsSXPbJ">
    <img alt=Support weight="10" src="https://github.com/CPN256/Neltechxmd/blob/main/logo.png"> 
    </p>
<p align="center"> 
    </p>
<p align="center">
  <a aria-label="Join our chats"
    href="https://chat.whatsapp.com/KMvJBu444hzEiAhzsSXPbJ"target="_blank">
    <img alt="whatsapp" src="https://img.shields.io/badge/Join Group chat-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" />
    <a align="center">
  <a aria-label="Follow Channel" href="https://whatsapp.com/channel/0029Vb7ARUq1iUxhqTjpPz0n" target="_blank">
    <img alt="whatsapp" src="https://img.shields.io/badge/Follow Channel-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" />
</a>
<a aria-label="Chat me" href="https://t.me/"CAT_PHOENIX" target="_blank">
    <img alt="telegram" src="https://img.shields.io/badge/Telegram Group-24A1DE?style=for-the-badge&logo=telegram&logoColor=white" />
  </a>
</p> 
      
A minimal WhatsApp bot built on [Baileys](https://github.com/WhiskeySockets/Baileys) that:

-Cat Cpn logs in using an **8-digit pairing code** (no QR scanning) — you enter your phone
  number in the console and type the code into WhatsApp > Linked Devices.
- Persists your session to `./auth_info/` (`creds.json` + signal key files), so it
  reconnects automatically on restart without pairing again.
- Auto-reconnects on any dropped connection, unless WhatsApp reports an actual
  logout (in which case it wipes the local session so you can re-pair cleanly).
- Sets the banner image as the bot's actual WhatsApp profile picture (once,
  on first successful connect), and sends it as the welcome image too.
- Sends and receives real WhatsApp messages — every inbound message is
  logged, and any command handler can call `sock.sendMessage()` to reply
  to any chat.
- Responds to three commands, all using the `.` prefix:
  - `.menu` — lists available commands
  - `.ping` — replies with round-trip latency and bot uptime
  - `.hello` — quick greeting
- Auto-views WhatsApp Status updates posted by your contacts.
- Shows a brief "typing..." presence before replying, so it doesn't feel like
  an instant script firing back.
- Logs every connection step (connecting, open, close reason, creds saved, etc.)
  to the console so it's easy to follow what's happening in the Pterodactyl console.

## Files

- `index.js` — the bot
- `package.json` — dependencies (published `baileys` npm package, pinned to
  match the version you're using)
- `assets/banner.png` — the welcome-image banner sent on successful connect;
  swap this file for your own artwork any time, same filename
- `auth_info/` — created automatically on first run, holds your session (never commit this)

## Running locally

```bash
npm install
npm start
```

The first time you run it, the console will prompt:

```
Enter your WhatsApp number with country code, digits only (e.g. 256750713834):
```

Enter it, wait for the 8-character pairing code to print, then in WhatsApp go to
**Settings > Linked Devices > Link a Device > Link with phone number instead**,
and type the code in. The bot will log `Connection opened successfully` and
DM you a confirmation.

## Deploying on Pterodactyl

1. Create a server using the **Node.js** egg (Node 20+).
2. Upload/extract this project into the server's file manager (or push it via SFTP),
   *excluding* `node_modules` and `auth_info` — those get created on the server.
   Make sure `assets/banner.png` comes along, or the welcome message falls
   back to text-only.
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
 
   <p align="left">  
  <!-- Website -->
  <a href="https://catcpn.cc.cd/" target="_blank" aria-label="CATCPN Website">  
    <img alt="CATCPN Website" src="https://img.shields.io/badge/CATCPN WEB-25D366?style=for-the-badge&logo=internetexplorer&logoColor=white" />  
  </a>  

  <!-- Other Repo -->
  <a href="https://github.com/CPN256/my-digital-twin" target="_blank" aria-label="Other Repo">  
    <img alt="Other Repo" src="https://img.shields.io/badge/OTHER REPO-0E1241?style=for-the-badge&logo=github&logoColor=white" />  
  </a>  

  <!-- YouTube -->
  <a href="https://www.youtube.com/@CatPhoenix" target="_blank" aria-label="Subscribe on YouTube">  
    <img alt="YouTube Channel" src="https://img.shields.io/badge/Subscribe-FF0000?style=for-the-badge&logo=youtube&logoColor=white" />  
  </a>  
</p>

 --- 
- Star ⭐ repo if you like this bot.



