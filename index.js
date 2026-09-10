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
const OWNER = 'Oundo Nelson'
const OWNER_PHONE = '0750713834'

const AUTH_DIR = path.join(process.cwd(), 'auth_info')
const LOGO_PATH = path.join(process.cwd(), 'assets', 'logo.png')
const STATUS_JID = 'status@broadcast'

const logger = pino({ level: 'silent' })

let sock = null
let reconnecting = false
let pairingRequested = false

// Message IDs created by the bot itself.
// This lets the bot process messages you type in your own WhatsApp chat
// without replying to its own automatic replies forever.
const botSentIds = new Set()

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

// Always use this wrapper for bot-generated messages.
// It records the message ID so self-chat messages from the bot are ignored.
async function sendMessage(jid, content, options = {}) {
  if (!sock) throw new Error('WhatsApp socket is not ready.')

  const sent = await sock.sendMessage(jid, content, options)

  if (sent?.key?.id) {
    botSentIds.add(sent.key.id)

    // Prevent the in-memory set from growing forever.
    if (botSentIds.size > 5000) {
      const first = botSentIds.values().next().value
      if (first) botSentIds.delete(first)
    }
  }

  return sent
}

// ================================================================
// START BOT
// ================================================================

async function startBot() {
  try {
    log(`🐾 Starting ${BOT_NAME}...`)

    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true })
      log('Created auth_info folder.')
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

    log('Getting latest WhatsApp Web version...')

    const { version, isLatest } = await fetchLatestBaileysVersion()

    log(
      `WhatsApp Web version: ${version.join('.')} | Latest: ${isLatest}`
    )

    pairingRequested = false

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },

      // Use a canonical browser profile for reliable pairing-code requests.
      browser: Browsers.ubuntu('Chrome'),

      // Pairing code only. No QR code in the terminal.
      printQRInTerminal: false,

      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: true
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      void handleConnectionUpdate(update)
    })

    sock.ev.on('messages.upsert', (upsert) => {
      void handleMessages(upsert)
    })

    log('WhatsApp socket created.')

    // Ask for pairing code only when the current auth state is not registered.
    if (!state.creds.registered) {
      // Wait for the socket to begin its connection flow.
      await sleep(2000)

      if (!pairingRequested && sock && !state.creds.registered) {
        await requestPairing()
      }
    }
  } catch (error) {
    log(`❌ Start error: ${error.stack || error}`)

    if (!reconnecting) {
      await sleep(5000)
      await reconnect()
    }
  }
}

// ================================================================
// PAIRING CODE
// ================================================================

async function requestPairing() {
  if (pairingRequested || !sock) return

  pairingRequested = true

  log('📱 WhatsApp account is not paired.')

  try {
    let phoneNumber = await ask(
      '\nEnter WhatsApp number with country code (digits only): '
    )

    phoneNumber = phoneNumber.replace(/\D/g, '')

    if (!phoneNumber) {
      log('❌ Invalid phone number. Please try again.')
      pairingRequested = false
      return requestPairing()
    }

    if (phoneNumber.length < 8) {
      log('❌ Phone number looks too short. Include the country code.')
      pairingRequested = false
      return requestPairing()
    }

    log(`Requesting pairing code for +${phoneNumber}...`)

    // WhatsApp pairing-code flow needs the socket to have started connecting.
    await sleep(1500)

    const code = await sock.requestPairingCode(phoneNumber)

    console.log('')
    console.log('========================================')
    console.log(`          🐾 ${BOT_NAME}`)
    console.log('========================================')
    console.log(`PAIRING CODE: ${code}`)
    console.log('========================================')
    console.log(
      'On WhatsApp: Linked Devices → Link a device →'
    )
    console.log(
      'Link with phone number instead → enter the code above.'
    )
    console.log('========================================')
    console.log('')

    log('✅ Pairing code generated successfully.')
  } catch (error) {
    pairingRequested = false

    log(`❌ Pairing failed: ${error?.message || error}`)

    console.log(
      '\nThe pairing code could not be generated. The bot will retry.'
    )

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
  const { connection, lastDisconnect } = update

  if (connection === 'connecting') {
    log('🔄 Connecting to WhatsApp...')
  }

  if (connection === 'open') {
    reconnecting = false
    pairingRequested = true

    log('========================================')
    log(`✅ ${BOT_NAME} CONNECTED SUCCESSFULLY`)
    log('========================================')
    log(`Logged in as: ${sock?.user?.id || 'unknown'}`)

    await sleep(1500)
    await sendConnectedMessage()
  }

  if (connection === 'close') {
    const statusCode =
      new Boom(lastDisconnect?.error)?.output?.statusCode

    log(`❌ WhatsApp connection closed. Code: ${statusCode}`)

    if (statusCode === DisconnectReason.loggedOut) {
      log('🚪 WhatsApp session was logged out.')

      try {
        fs.rmSync(AUTH_DIR, {
          recursive: true,
          force: true
        })
      } catch {}

      log('Authentication data deleted.')
      log('Restart the bot to pair again.')
      process.exit(1)
    }

    log('🔄 Connection lost. Reconnecting...')
    await reconnect()
  }
}

// ================================================================
// RECONNECT
// ================================================================

async function reconnect() {
  if (reconnecting) return

  reconnecting = true

  await sleep(5000)

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
    const rawJid = sock?.user?.id

    if (!rawJid) {
      log('Cannot determine own WhatsApp JID.')
      return
    }

    const jid = jidNormalizedUser(rawJid)

    const text =
      `🐾 *${BOT_NAME}*\n\n` +
      `✅ WhatsApp connected successfully!\n\n` +
      `The bot can now send and receive messages.\n\n` +
      `👑 Owner: ${OWNER}\n` +
      `📱 ${OWNER_PHONE}\n\n` +
      `Type *${PREFIX}menu* to see commands.`

    if (fs.existsSync(LOGO_PATH)) {
      await sendMessage(jid, {
        image: fs.readFileSync(LOGO_PATH),
        caption: text
      })
    } else {
      await sendMessage(jid, { text })
    }

    log('📤 Connected message sent.')
  } catch (error) {
    log(`Could not send connected message: ${error?.message || error}`)
  }
}

// ================================================================
// MESSAGE RECEIVING
// ================================================================

async function handleMessages(upsert) {
  if (upsert?.type !== 'notify') return

  for (const msg of upsert.messages || []) {
    try {
      if (!msg?.message) continue

      const jid = msg.key?.remoteJid

      if (!jid) continue

      // ----------------------------------------------------------
      // Status
      // ----------------------------------------------------------

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
            log(`Status error: ${error?.message || error}`)
          }
        }

        continue
      }

      // ----------------------------------------------------------
      // IMPORTANT SELF-CHAT FIX
      // ----------------------------------------------------------
      //
      // WhatsApp marks messages you type from the same account as
      // "fromMe: true". The old code ignored ALL fromMe messages,
      // which is why your own messages were not being processed.
      //
      // We now ignore only messages that this bot itself sent.
      // Messages typed manually by you in your own chat are allowed.
      // ----------------------------------------------------------

      if (msg.key?.fromMe && botSentIds.has(msg.key.id)) {
        botSentIds.delete(msg.key.id)
        continue
      }

      const message = msg.message

      const text =
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        message.buttonsResponseMessage?.selectedButtonId ||
        message.listResponseMessage?.singleSelectReply?.selectedRowId ||
        message.interactiveResponseMessage?.body?.text ||
        ''

      const body = text.trim()

      const isGroup = jid.endsWith('@g.us')
      const isFromMe = Boolean(msg.key?.fromMe)

      log(
        `📩 RECEIVED ${
          isFromMe ? '[SELF]' : ''
        } from ${jid}: ${body || '[media/message]'}`
      )

      // ----------------------------------------------------------
      // Normal messages
      // ----------------------------------------------------------

      if (!body.startsWith(PREFIX)) {
        if (body && !isGroup) {
          await typing(jid)

          await sendMessage(jid, {
            text:
              `👋 Hello!\n\n` +
              `I received your message:\n\n` +
              `"${body}"\n\n` +
              `🐾 *${BOT_NAME}* is online.\n\n` +
              `Type *${PREFIX}menu* for commands.`
          })

          log(`📤 REPLIED to ${jid}`)
        }

        continue
      }

      // ----------------------------------------------------------
      // Command parser
      // ----------------------------------------------------------

      const commandLine = body.slice(PREFIX.length).trim()

      if (!commandLine) continue

      const parts = commandLine.split(/\s+/)
      const command = parts.shift().toLowerCase()
      const args = parts

      log(`⚡ COMMAND: ${PREFIX}${command}`)

      await typing(jid)

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
            await sendMessage(jid, {
              text: `Usage:\n${PREFIX}say your message`
            })
          } else {
            await sendMessage(jid, {
              text: args.join(' ')
            })
          }
          break

        case 'id':
          await sendMessage(jid, {
            text:
              `🆔 *Chat ID*\n\n` +
              jid
          })
          break

        case 'owner':
          await sendMessage(jid, {
            text:
              `👑 *${BOT_NAME} OWNER*\n\n` +
              `Name: ${OWNER}\n` +
              `Phone: ${OWNER_PHONE}`
          })
          break

        case 'uptime':
          await sendMessage(jid, {
            text:
              `⏱️ *${BOT_NAME} UPTIME*\n\n` +
              formatUptime(process.uptime())
          })
          break

        default:
          await sendMessage(jid, {
            text:
              `❌ Unknown command:\n` +
              `*${PREFIX}${command}*\n\n` +
              `Type *${PREFIX}menu*`
          })
      }

      log(`📤 RESPONSE SENT to ${jid}`)
    } catch (error) {
      log(`❌ Message error: ${error?.stack || error}`)

      try {
        if (msg.key?.remoteJid) {
          await sendMessage(msg.key.remoteJid, {
            text:
              '⚠️ An error occurred while processing your message.'
          })
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
    await sock.sendPresenceUpdate('composing', jid)
    await sleep(600)
    await sock.sendPresenceUpdate('paused', jid)
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
    `✓ Automatic replies\n` +
    `✓ Self-chat support\n\n` +
    `⚡ *COMMANDS*\n` +
    `• ${PREFIX}menu\n` +
    `• ${PREFIX}ping\n` +
    `• ${PREFIX}hello\n` +
    `• ${PREFIX}say <text>\n` +
    `• ${PREFIX}id\n` +
    `• ${PREFIX}owner\n` +
    `• ${PREFIX}uptime\n\n` +
    `👑 *OWNER*\n` +
    `${OWNER}\n` +
    `${OWNER_PHONE}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `CAT CPN is online 🐾`

  await sendMessage(jid, { text })
}

// ================================================================
// PING
// ================================================================

async function ping(jid) {
  const start = Date.now()

  const sent = await sendMessage(jid, {
    text: '🏓 Checking CAT CPN...'
  })

  const latency = Date.now() - start

  // Delete is intentionally not used because it can vary by
  // WhatsApp/Baileys version and is unnecessary for this command.
  await sendMessage(jid, {
    text:
      `🏓 *PONG!*\n\n` +
      `⚡ Response: ${latency} ms\n` +
      `🐾 ${BOT_NAME} is online.`
  })
}

// ================================================================
// HELLO
// ================================================================

async function hello(jid) {
  await sendMessage(jid, {
    text:
      `👋 *Hello!*\n\n` +
      `I am *${BOT_NAME}*.\n` +
      `How can I help you? 🐾`
  })
}

// ================================================================
// UPTIME FORMAT
// ================================================================

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400)
  seconds %= 86400

  const hours = Math.floor(seconds / 3600)
  seconds %= 3600

  const minutes = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)

  return `${days}d ${hours}h ${minutes}m ${secs}s`
}

// ================================================================
// PROCESS ERRORS
// ================================================================

process.on('uncaughtException', (error) => {
  log(`❌ Uncaught exception: ${error.stack || error}`)
})

process.on('unhandledRejection', (error) => {
  log(`❌ Unhandled rejection: ${error?.stack || error}`)
})

process.on('SIGINT', () => {
  log('Stopping CAT CPN...')
  rl.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  log('Stopping CAT CPN...')
  rl.close()
  process.exit(0)
})

// ================================================================
// START
// ================================================================

startBot()
