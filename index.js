/**
 * WhatsApp Bot (Baileys) — Pairing Code Login
 * -------------------------------------------------
 * - Logs in via 8-digit pairing code (no QR scanning)
 * - Persists credentials + signal keys to ./auth_info (creds.json + key files)
 * - Auto-reconnects on drop, unless it's an intentional logout
 * - Sends a "connected successfully" DM to your own number on login
 * - Responds to "." prefixed commands: .menu / .ping
 *
 * Designed to run under Pterodactyl (Node.js egg):
 *   Startup command: node index.js
 */

import makeWASocket, {
	useMultiFileAuthState,
	fetchLatestBaileysVersion,
	makeCacheableSignalKeyStore,
	DisconnectReason,
	Browsers
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
const AUTH_DIR = path.join(process.cwd(), 'auth_info')
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
		await sendSelfSuccessMessage()
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

// Sends a confirmation message to the paired account's own chat
// (i.e. "Message yourself" in WhatsApp) once the connection is live.
async function sendSelfSuccessMessage() {
	try {
		const jid = sock.user?.id
		if (!jid) return
		await sock.sendMessage(jid, {
			text:
				'✅ *Connected successfully!*\n\n' +
				'Your WhatsApp bot is now online and listening for commands.\n' +
				`Type *${PREFIX}menu* to see what I can do.`
		})
		log('Sent success confirmation DM to your own number.')
	} catch (err) {
		log(`Could not send success DM: ${err.message}`)
	}
}

// ------------------------------------------------------------------
// Incoming messages / commands
// ------------------------------------------------------------------
async function handleMessages(upsert) {
	if (upsert.type !== 'notify') return

	for (const msg of upsert.messages) {
		if (!msg.message || msg.key.fromMe) continue

		const from = msg.key.remoteJid
		const text =
			msg.message.conversation ||
			msg.message.extendedTextMessage?.text ||
			msg.message.imageMessage?.caption ||
			msg.message.videoMessage?.caption ||
			''

		if (!text.startsWith(PREFIX)) continue

		const [rawCommand, ...args] = text.slice(PREFIX.length).trim().split(/\s+/)
		const command = rawCommand.toLowerCase()

		log(`Command received from ${from}: ${PREFIX}${command}`)

		try {
			if (command === 'menu') {
				await handleMenu(from)
			} else if (command === 'ping') {
				await handlePing(from)
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

async function handleMenu(jid) {
	const menuText =
		'🤖 *Available Commands*\n\n' +
		`${PREFIX}menu — show this list of commands\n` +
		`${PREFIX}ping — check bot latency and uptime\n`
	await sock.sendMessage(jid, { text: menuText })
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
