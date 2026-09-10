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

const PREFIX = '.'
const BOT_NAME = 'CAT CPN'

const AUTH_DIR = path.join(process.cwd(), 'auth_info')
const BANNER_PATH = path.join(process.cwd(), 'assets', 'banner.png')

const STATUS_JID = 'status@broadcast'
const START_TIME = Date.now()

const logger = pino({ level: 'silent' })

let sock = null
let reconnecting = false

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
})

const ask = (question) =>
	new Promise((resolve) => rl.question(question, resolve))

function log(message) {
	console.log(`[${new Date().toISOString()}] ${message}`)
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

// ================================================================
// START BOT
// ================================================================

async function startBot() {
	try {
		log('🐾 Starting CAT CPN...')

		if (!fs.existsSync(AUTH_DIR)) {
			fs.mkdirSync(AUTH_DIR, { recursive: true })
			log('Created auth_info folder.')
		} else {
			log('Existing authentication folder found.')
		}

		const { state, saveCreds } =
			await useMultiFileAuthState(AUTH_DIR)

		log('Getting latest WhatsApp Web version...')

		const { version, isLatest } =
			await fetchLatestBaileysVersion()

		log(
			`WhatsApp Web version: ${version.join('.')} | Latest: ${isLatest}`
		)

		sock = makeWASocket({
			version,

			logger,

			auth: {
				creds: state.creds,
				keys: makeCacheableSignalKeyStore(
					state.keys,
					logger
				)
			},

			browser: Browsers.ubuntu('Chrome'),

			printQRInTerminal: false,

			generateHighQualityLinkPreview: true,

			markOnlineOnConnect: true
		})

		// Save credentials whenever they change.
		sock.ev.on('creds.update', saveCreds)

		// Connection events.
		sock.ev.on(
			'connection.update',
			handleConnectionUpdate
		)

		// Incoming messages.
		sock.ev.on(
			'messages.upsert',
			handleMessages
		)

		log('WhatsApp socket created.')

		// ------------------------------------------------------------
		// Pairing code
		// ------------------------------------------------------------

		if (!state.creds.registered) {
			await requestPairing()
		}

	} catch (error) {
		log(`❌ Start error: ${error.stack || error}`)

		await sleep(5000)

		if (!reconnecting) {
			reconnect()
		}
	}
}

// ================================================================
// PAIRING CODE
// ================================================================

async function requestPairing() {
	log('📱 WhatsApp account is not paired.')

	let phoneNumber = await ask(
		'\nEnter WhatsApp number with country code (digits only): '
	)

	phoneNumber = phoneNumber.replace(/\D/g, '')

	if (!phoneNumber) {
		log('❌ Invalid phone number.')
		return requestPairing()
	}

	log(`Requesting pairing code for +${phoneNumber}...`)

	try {
		/*
		 * Give the socket a moment to establish its connection
		 * before requesting the pairing code.
		 */
		await sleep(1500)

		const code =
			await sock.requestPairingCode(phoneNumber)

		console.log('')
		console.log('========================================')
		console.log(`      🐾 ${BOT_NAME}`)
		console.log('========================================')
		console.log(`PAIRING CODE: ${code}`)
		console.log('========================================')
		console.log(
			'Open WhatsApp → Linked Devices → Link with phone number'
		)
		console.log('Enter the code shown above.')
		console.log('========================================')
		console.log('')

	} catch (error) {
		log(`❌ Pairing failed: ${error.message}`)

		await sleep(5000)

		if (sock && !sock.authState?.creds?.registered) {
			return requestPairing()
		}
	}
}

// ================================================================
// CONNECTION
// ================================================================

async function handleConnectionUpdate(update) {
	const {
		connection,
		lastDisconnect
	} = update

	if (connection === 'connecting') {
		log('🔄 Connecting to WhatsApp...')
	}

	if (connection === 'open') {
		reconnecting = false

		log('========================================')
		log('✅ CAT CPN CONNECTED SUCCESSFULLY')
		log('========================================')

		log(`Logged in as: ${sock.user?.id || 'unknown'}`)

		await sleep(2000)

		await sendConnectedMessage()
	}

	if (connection === 'close') {

		const statusCode =
			new Boom(lastDisconnect?.error)
				?.output?.statusCode

		log(
			`❌ WhatsApp connection closed. Code: ${statusCode}`
		)

		if (
			statusCode === DisconnectReason.loggedOut
		) {
			log('🚪 WhatsApp session was logged out.')

			try {
				fs.rmSync(
					AUTH_DIR,
					{
						recursive: true,
						force: true
					}
				)
			} catch {}

			log('Authentication data deleted.')
			log('Restart the bot to pair again.')

			process.exit(1)
		}

		log('🔄 Connection lost. Reconnecting...')

		reconnect()
	}
}

// ================================================================
// RECONNECT
// ================================================================

async function reconnect() {
	if (reconnecting) return

	reconnecting = true

	await sleep(5000)

	log('Starting reconnection...')

	try {
		if (sock) {
			try {
				sock.end?.(undefined)
			} catch {}
		}
	} catch {}

	reconnecting = false

	await startBot()
}

// ================================================================
// CONNECTED MESSAGE
// ================================================================

async function sendConnectedMessage() {
	try {
		const rawJid = sock.user?.id

		if (!rawJid) {
			log('Cannot determine own WhatsApp JID.')
			return
		}

		const jid = jidNormalizedUser(rawJid)

		const text =
			`🐾 *${BOT_NAME}*\n\n` +
			`✅ WhatsApp connected successfully!\n\n` +
			`The bot can now send and receive messages.\n\n` +
			`Type *${PREFIX}menu* to see available commands.`

		if (fs.existsSync(BANNER_PATH)) {
			await sock.sendMessage(jid, {
				image: fs.readFileSync(BANNER_PATH),
				caption: text
			})
		} else {
			await sock.sendMessage(jid, {
				text
			})
		}

		log('📤 Connected message sent.')

	} catch (error) {
		log(
			`Could not send connected message: ${error.message}`
		)
	}
}

// ================================================================
// MESSAGE RECEIVING
// ================================================================

async function handleMessages(upsert) {

	if (upsert.type !== 'notify') return

	for (const msg of upsert.messages) {

		try {

			if (!msg?.message) continue

			const jid = msg.key.remoteJid

			if (!jid) continue

			// --------------------------------------------------------
			// Status
			// --------------------------------------------------------

			if (jid === STATUS_JID) {

				if (!msg.key.fromMe) {

					try {
						await sock.readMessages([msg.key])

						log(
							`👁️ Viewed status from ${
								msg.key.participant || 'unknown'
							}`
						)

					} catch (error) {
						log(
							`Status error: ${error.message}`
						)
					}
				}

				continue
			}

			// --------------------------------------------------------
			// Ignore our own messages
			// --------------------------------------------------------

			if (msg.key.fromMe) continue

			// --------------------------------------------------------
			// Extract text
			// --------------------------------------------------------

			const message = msg.message

			const text =
				message.conversation ||
				message.extendedTextMessage?.text ||
				message.imageMessage?.caption ||
				message.videoMessage?.caption ||
				message.documentMessage?.caption ||
				message.buttonsResponseMessage
					?.selectedButtonId ||
				message.listResponseMessage
					?.singleSelectReply
					?.selectedRowId ||
				''

			const body = text.trim()

			const isGroup =
				jid.endsWith('@g.us')

			log(
				`📩 RECEIVED from ${jid}: ${
					body || '[media/message]'
				}`
			)

			// --------------------------------------------------------
			// Normal messages
			// --------------------------------------------------------

			if (!body.startsWith(PREFIX)) {

				if (!isGroup && body) {

					await typing(jid)

					await sock.sendMessage(jid, {
						text:
							`👋 Hello!\n\n` +
							`I received your message:\n\n` +
							`"${body}"\n\n` +
							`🐾 *${BOT_NAME}* is online.\n\n` +
							`Type *${PREFIX}menu* for commands.`
					})

					log(
						`📤 REPLIED to ${jid}`
					)
				}

				continue
			}

			// --------------------------------------------------------
			// Command parser
			// --------------------------------------------------------

			const commandLine =
				body
					.slice(PREFIX.length)
					.trim()

			if (!commandLine) continue

			const parts =
				commandLine.split(/\s+/)

			const command =
				parts.shift().toLowerCase()

			const args = parts

			log(
				`⚡ COMMAND: ${PREFIX}${command}`
			)

			await typing(jid)

			// --------------------------------------------------------
			// Commands
			// --------------------------------------------------------

			switch (command) {

				case 'menu':
					await menu(jid)
					break

				case 'ping':
					await ping(jid)
					break

				case 'hello':
					await hello(jid)
					break

				case 'say':

					if (!args.length) {

						await sock.sendMessage(jid, {
							text:
								`Usage:\n${PREFIX}say your message`
						})

					} else {

						await sock.sendMessage(jid, {
							text: args.join(' ')
						})
					}

					break

				case 'id':

					await sock.sendMessage(jid, {
						text:
							`🆔 *Chat ID*\n\n` +
							`${jid}`
					})

					break

				default:

					await sock.sendMessage(jid, {
						text:
							`❌ Unknown command:\n` +
							`*${PREFIX}${command}*\n\n` +
							`Type *${PREFIX}menu*`
					})
			}

			log(
				`📤 RESPONSE SENT to ${jid}`
			)

		} catch (error) {

			log(
				`❌ Message error: ${error.stack || error}`
			)

			try {

				if (msg.key?.remoteJid) {

					await sock.sendMessage(
						msg.key.remoteJid,
						{
							text:
								'⚠️ An error occurred while processing your message.'
						}
					)
				}

			} catch {}
		}
	}
}

// ================================================================
// TYPING
// ================================================================

async function typing(jid) {

	try {

		await sock.sendPresenceUpdate(
			'composing',
			jid
		)

		await sleep(600)

		await sock.sendPresenceUpdate(
			'paused',
			jid
		)

	} catch {}
}

// ================================================================
// MENU
// ================================================================

async function menu(jid) {

	const text =
		`🐾 *${BOT_NAME}*\n` +
		`━━━━━━━━━━━━━━━━━━\n\n` +

		`📱 *MESSAGING*\n` +
		`✓ Send messages\n` +
		`✓ Receive messages\n` +
		`✓ Automatic replies\n\n` +

		`⚡ *COMMANDS*\n\n` +
		`*${PREFIX}menu*\n` +
		`Show this menu\n\n` +

		`*${PREFIX}ping*\n` +
		`Check bot latency\n\n` +

		`*${PREFIX}hello*\n` +
		`Say hello\n\n` +

		`*${PREFIX}say text*\n` +
		`Send text back\n\n` +

		`*${PREFIX}id*\n` +
		`Show chat ID\n\n` +

		`━━━━━━━━━━━━━━━━━━\n` +
		`🟢 Online\n` +
		`🔄 Auto reconnect\n` +
		`💾 Session saved`

	await sock.sendMessage(jid, {
		text
	})
}

// ================================================================
// HELLO
// ================================================================

async function hello(jid) {

	await sock.sendMessage(jid, {
		text:
			`👋 Hello!\n\n` +
			`I'm *${BOT_NAME}* 🐾\n\n` +
			`I'm online and ready to receive messages.`
	})
}

// ================================================================
// PING
// ================================================================

async function ping(jid) {

	const start = Date.now()

	const sent =
		await sock.sendMessage(jid, {
			text: '🏓 Pinging...'
		})

	const latency =
		Date.now() - start

	const uptime =
		formatUptime(
			Date.now() - START_TIME
		)

	await sock.sendMessage(
		jid,
		{
			text:
				`🏓 *PONG!*\n\n` +
				`⚡ Latency: ${latency}ms\n` +
				`⏱️ Uptime: ${uptime}`
		},
		{
			quoted: sent
		}
	)
}

// ================================================================
// UPTIME
// ================================================================

function formatUptime(ms) {

	const seconds =
		Math.floor(ms / 1000)

	const days =
		Math.floor(seconds / 86400)

	const hours =
		Math.floor(
			(seconds % 86400) / 3600
		)

	const minutes =
		Math.floor(
			(seconds % 3600) / 60
		)

	const secs =
		seconds % 60

	const parts = []

	if (days)
		parts.push(`${days}d`)

	if (hours)
		parts.push(`${hours}h`)

	if (minutes)
		parts.push(`${minutes}m`)

	parts.push(`${secs}s`)

	return parts.join(' ')
}

// ================================================================
// ERROR HANDLERS
// ================================================================

process.on(
	'uncaughtException',
	(error) => {

		log(
			`❌ Uncaught exception: ${
				error.stack || error
			}`
		)
	}
)

process.on(
	'unhandledRejection',
	(reason) => {

		log(
			`❌ Unhandled rejection: ${reason}`
		)
	}
)

// ================================================================
// START
// ================================================================

startBot()
