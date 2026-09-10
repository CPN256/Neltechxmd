/**
 * WhatsApp Bot (Baileys) — Pairing Code Login
 * -------------------------------------------------
 * - Logs in via 8-digit pairing code (no QR scanning)
 * - Persists credentials + signal keys to ./auth_info (creds.json + key files)
 * - Auto-reconnects on drop, unless it's an intentional logout
 * - Sends a branded "connected successfully" image + caption to your own
 *   number on login
 * - Responds to "." prefixed commands: .menu / .ping / .hello
 * - Auto-views WhatsApp Status updates from your contacts
 *
 * Designed to run under Pterodactyl (Node.js egg):
 *   Startup command: node index.js
 */

import makeWASocket, {
	useMultiFileAuthState,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	DisconnectReason,
	Browsers,
	jidNormalizedUser
} from 'baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import readline from 'readline'
import path from 'path'
import fs from 'fs'

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const PREFIX = '.'
const BOT_NAME = 'CAT CPN'
const AUTH_DIR = path.join(process.cwd(), 'auth_info')
const BANNER_PATH = path.join(process.cwd(), 'assets', 'banner.png')
const PROFILE_PIC_MARKER = path.join(AUTH_DIR, '.profile_pic_set')
const STATUS_JID = 'status@broadcast'
const START_TIME = Date.now()

// Baileys internals stay quiet — we print our own step-by-step logs below.
const baileysLogger = pino({ level: 'silent' })

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (text) => new Promise((resolve) => rl.question(text, resolve))

// Small helper so every line is timestamped and easy to scan in the
// Pterodactyl console.
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`)

let sock // current socket instance, referenced by command handlers

// ------------------------------------------------------------------
// Connection bootstrap
// ------------------------------------------------------------------
async function startBot() {
	log('Booting WhatsApp bot...')

	if (!fs.existsSync(AUTH_DIR)) {
		log(`No existing session found — creating auth folder at ${AUTH_DIR}`)
	} else {
		log(`Existing session found at ${AUTH_DIR}, attempting to restore it`)
	}

	// useMultiFileAuthState persists creds.json + one file per signal key
	// (pre-key bundles, session records, sender keys, etc.) inside AUTH_DIR,
	// and hands back a saveCreds() callback we call on every creds.update.
	const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

	log('Fetching latest WhatsApp Web version...')
	const { version, isLatest } = await fetchLatestBaileysVersion()
	log(`Using WA version ${version.join('.')} (latest: ${isLatest})`)

	sock = makeWASocket({
		version,
		logger: baileysLogger,
		// We're doing pairing-code auth, not QR — printQRInTerminal must stay off.
		printQRInTerminal: false,
		browser: Browsers.ubuntu('Chrome'),
		auth: {
			creds: state.creds,
			// Wraps the key store with an in-memory cache so repeated reads
			// of the same pre-key/session don't hit disk every time.
			keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
		},
		generateHighQualityLinkPreview: true
	})

	// If we're not registered yet, kick off the pairing-code flow.
	if (!sock.authState.creds.registered) {
		await requestPairing()
	}

	// ------------------------------------------------------------------
	// Event handling
	// ------------------------------------------------------------------
	sock.ev.process(async (events) => {
		if (events['connection.update']) {
			await handleConnectionUpdate(events['connection.update'])
		}

		if (events['creds.update']) {
			await saveCreds()
			log('Credentials updated and saved to disk (creds.json)')
		}

		if (events['messages.upsert']) {
			await handleMessages(events['messages.upsert'])
		}
	})
}

// ------------------------------------------------------------------
// Pairing code flow
// ------------------------------------------------------------------
async function requestPairing() {
	log('Device is not registered yet — pairing required.')
	let phoneNumber = await ask(
		'Enter your WhatsApp number with country code, digits only (e.g. 15551234567): '
	)
	phoneNumber = phoneNumber.replace(/[^0-9]/g, '')

	if (!phoneNumber) {
		log('No valid number entered, asking again...')
		return requestPairing()
	}

	log(`Requesting pairing code for +${phoneNumber}...`)
	try {
		// Baileys generates an 8-character pairing code by default
		// (bytesToCrockford(randomBytes(5))) when no custom code is passed.
		const code = await sock.requestPairingCode(phoneNumber)
		log('========================================')
		log(`  PAIRING CODE: ${code}`)
		log('  Open WhatsApp > Linked Devices > Link with phone number')
		log('  and enter this code within 60 seconds.')
		log('========================================')
	} catch (err) {
		log(`Failed to request pairing code: ${err.message}`)
		log('Retrying in 5 seconds...')
		await new Promise((r) => setTimeout(r, 5000))
		return requestPairing()
	}
}

// ------------------------------------------------------------------
// Connection state changes
// ------------------------------------------------------------------
async function handleConnectionUpdate(update) {
	const { connection, lastDisconnect, qr } = update

	if (qr) {
		log('QR code received (unused in pairing-code mode) — ignoring.')
	}

	if (connection === 'connecting') {
		log('Connecting to WhatsApp servers...')
	}

	if (connection === 'open') {
		log('✅ Connection opened successfully — bot is online.')
		log(`Logged in as: ${sock.user?.id ?? 'unknown'}`)
		// Small initial delay so a fresh pairing has time to finish
		// syncing session/pre-key material before we send anything.
		setTimeout(() => sendSelfSuccessMessage(), 2000)
		setTimeout(() => updateBotProfilePicture(), 2500)
	}

	if (connection === 'close') {
		const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
		const reason = DisconnectReason[statusCode] ?? statusCode ?? 'unknown'
		log(`❌ Connection closed. Reason: ${reason} (code: ${statusCode})`)

		if (statusCode === DisconnectReason.loggedOut) {
			log('Session was logged out from the phone. Deleting local auth data.')
			log('Restart the bot to pair again with a fresh code.')
			fs.rmSync(AUTH_DIR, { recursive: true, force: true })
			process.exit(1)
		} else {
			log('Not a logout — reconnecting...')
			startBot()
		}
	}
}

// Sets the WhatsApp account's profile picture to the banner image so the
// logo actually shows up as the bot's avatar in chats, not just inside the
// welcome message. Only runs once per pairing (tracked via a marker file) —
// otherwise every restart/reconnect would re-upload it unnecessarily.
async function updateBotProfilePicture() {
	if (!fs.existsSync(BANNER_PATH)) {
		log('updateBotProfilePicture: banner.png not found, skipping.')
		return
	}
	if (fs.existsSync(PROFILE_PIC_MARKER)) {
		return
	}

	const rawJid = sock.user?.id
	if (!rawJid) return
	const jid = jidNormalizedUser(rawJid)

	try {
		await sock.updateProfilePicture(jid, { url: BANNER_PATH })
		fs.writeFileSync(PROFILE_PIC_MARKER, new Date().toISOString())
		log('Set bot profile picture to the banner logo.')
	} catch (err) {
		log(`Could not set profile picture: ${err.message}`)
	}
}

// Sends a confirmation message to the paired account's own chat
// (i.e. "Message yourself" in WhatsApp) once the connection is live.
//
// Right after a fresh pairing, WhatsApp may not have finished syncing
// session/pre-key material yet, so a message fired the instant the
// connection opens can fail. We retry a few times with a short delay
// to ride that out instead of silently giving up.
async function sendSelfSuccessMessage(attempt = 1) {
	const MAX_ATTEMPTS = 4
	const DELAY_MS = 3000

	const rawJid = sock.user?.id
	if (!rawJid) {
		log('sendSelfSuccessMessage: sock.user.id not available yet, skipping.')
		return
	}
	// sock.user.id can include a ":device" suffix — normalize it the same
	// way Baileys does internally, or the send silently won't land in the
	// visible "Message Yourself" chat.
	const jid = jidNormalizedUser(rawJid)

	const caption =
		`🐾 *${BOT_NAME}* is online!\n` +
		'_Your WhatsApp Partner — Always Online_\n\n' +
		'✅ Paired successfully\n' +
		'✅ Session saved — no need to re-pair on restart\n' +
		'✅ Auto-reconnect enabled\n' +
		'✅ Auto-viewing your contacts\' Status updates\n\n' +
		`Type *${PREFIX}menu* to see everything I can do.\n` +
		'_Simple · Fast · Reliable_'

	try {
		if (fs.existsSync(BANNER_PATH)) {
			await sock.sendMessage(jid, {
				image: fs.readFileSync(BANNER_PATH),
				caption
			})
		} else {
			// Falls back to text only if the banner image isn't present
			// on disk (e.g. it wasn't uploaded alongside index.js).
			await sock.sendMessage(jid, { text: caption })
		}
		log('Sent success confirmation DM to your own number.')
	} catch (err) {
		log(`Could not send success DM (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`)
		if (attempt < MAX_ATTEMPTS) {
			setTimeout(() => sendSelfSuccessMessage(attempt + 1), DELAY_MS)
		} else {
			log('Giving up on the success DM after repeated failures — bot is still online.')
		}
	}
}

// ------------------------------------------------------------------
// Incoming messages / commands
// ------------------------------------------------------------------
async function handleMessages(upsert) {
	if (upsert.type !== 'notify') return

	for (const msg of upsert.messages) {
		if (!msg.message) continue

		// Auto-view Status updates: WhatsApp represents a contact's Status
		// post as a normal message addressed to "status@broadcast". Marking
		// it read (the same call used for normal read receipts) is what
		// makes it show up as "viewed" on their end.
		if (msg.key.remoteJid === STATUS_JID) {
			if (!msg.key.fromMe) {
				try {
					await sock.readMessages([msg.key])
					log(`Auto-viewed status from ${msg.key.participant ?? 'unknown contact'}`)
				} catch (err) {
					log(`Failed to auto-view status: ${err.message}`)
				}
			}
			continue
		}

		if (msg.key.fromMe) continue

		const from = msg.key.remoteJid
		const text =
			msg.message.conversation ||
			msg.message.extendedTextMessage?.text ||
			msg.message.imageMessage?.caption ||
			msg.message.videoMessage?.caption ||
			''

		// Every inbound message lands here regardless of content — this is
		// where you'd hook in logging, storage, or auto-replies beyond
		// commands.
		log(`Message received from ${from}: "${text || '[non-text message]'}"`)

		const isGroup = from.endsWith('@g.us')

		if (!text.startsWith(PREFIX)) {
			// Plain message, not a command. Reply directly in 1:1 chats so
			// the bot actually sends & receives real conversation — skip
			// groups so it doesn't spam every message sent in one.
			if (!isGroup && text) {
				try {
					await typingBurst(from)
					await handlePlainMessage(from, text)
				} catch (err) {
					log(`Error auto-replying to ${from}: ${err.message}`)
				}
			}
			continue
		}

		const [rawCommand, ...args] = text.slice(PREFIX.length).trim().split(/\s+/)
		const command = rawCommand.toLowerCase()

		log(`Command received from ${from}: ${PREFIX}${command}`)

		try {
			// Brief "typing..." presence before replying — purely cosmetic,
			// makes the bot feel less like a script firing instant replies.
			await typingBurst(from)

			if (command === 'menu') {
				await handleMenu(from)
			} else if (command === 'ping') {
				await handlePing(from)
			} else if (command === 'hello') {
				await handleHello(from)
			} else {
				// Unknown commands are ignored silently so the bot doesn't
				// spam every random message starting with a period.
				log(`Unknown command "${command}" — ignored.`)
			}
		} catch (err) {
			log(`Error handling command "${command}": ${err.message}`)
		}
	}
}

// Replies to a plain message that wasn't a command — a simple
// acknowledgment so the bot demonstrably sends & receives real messages,
// with a nudge toward the command list.
async function handlePlainMessage(jid, text) {
	await sock.sendMessage(jid, {
		text:
			`👋 Got your message: "_${text}_"\n\n` +
			`I mainly respond to commands — type *${PREFIX}menu* to see what I can do.`
	})
}

// Shows a short "composing..." presence to the chat before a reply lands.
async function typingBurst(jid, ms = 700) {
	try {
		await sock.sendPresenceUpdate('composing', jid)
		await new Promise((r) => setTimeout(r, ms))
		await sock.sendPresenceUpdate('paused', jid)
	} catch {
		// Presence updates are cosmetic only — never let a failure here
		// block the actual command reply.
	}
}

async function handleMenu(jid) {
	const menuText =
		`🐾 *${BOT_NAME}* — Pair · Chat · Automate\n\n` +
		'*Commands*\n' +
		`${PREFIX}menu — show this list of commands\n` +
		`${PREFIX}ping — check bot latency and uptime\n` +
		`${PREFIX}hello — say hello to the bot\n\n` +
		'*Running in the background*\n' +
		'✓ Auto-reconnect\n' +
		"✓ Auto-view Status updates\n" +
		'✓ Persistent session (no re-pairing after restarts)\n\n' +
		'_Simple · Fast · Reliable_'
	await sock.sendMessage(jid, { text: menuText })
}

async function handleHello(jid) {
	await sock.sendMessage(jid, {
		text: `👋 Hey there! ${BOT_NAME} here — type *${PREFIX}menu* to see what I can do.`
	})
}

async function handlePing(jid) {
	const start = Date.now()
	// sendMessage resolves once WhatsApp has accepted the message,
	// giving us a round-trip latency figure.
	const sent = await sock.sendMessage(jid, { text: '🏓 Pinging...' })
	const latencyMs = Date.now() - start

	const uptimeMs = Date.now() - START_TIME
	const uptimeStr = formatUptime(uptimeMs)

	await sock.sendMessage(
		jid,
		{
			text: `🏓 *Pong!*\n\nLatency: ${latencyMs}ms\nUptime: ${uptimeStr}`
		},
		{ quoted: sent }
	)
}

function formatUptime(ms) {
	const totalSeconds = Math.floor(ms / 1000)
	const days = Math.floor(totalSeconds / 86400)
	const hours = Math.floor((totalSeconds % 86400) / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60
	const parts = []
	if (days) parts.push(`${days}d`)
	if (hours) parts.push(`${hours}h`)
	if (minutes) parts.push(`${minutes}m`)
	parts.push(`${seconds}s`)
	return parts.join(' ')
}

// ------------------------------------------------------------------
// Process-level safety nets (important on Pterodactyl so the whole
// container doesn't die on an unexpected rejection/exception)
// ------------------------------------------------------------------
process.on('uncaughtException', (err) => log(`Uncaught exception: ${err.stack || err}`))
process.on('unhandledRejection', (reason) => log(`Unhandled rejection: ${reason}`))

startBot()
