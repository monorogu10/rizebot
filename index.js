require('dotenv').config();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client, GatewayIntentBits: I, Partials: T } = require('discord.js');

const { maybeBlockLink } = require('./src/features/linkBlocker');
const { maybeReplyKeyword } = require('./src/features/keywordReply');
const { createMessageHandler } = require('./src/handlers/messageHandler');
const { registerMemberEvents } = require('./src/handlers/memberEvents');
const { registerPrivateRoleEvents } = require('./src/handlers/privateRoleHandler');
const { createRegisterHandler, createRegisterInteractionHandler } = require('./src/handlers/registerHandler');
const { createMinecraftBridgeHandler } = require('./src/handlers/minecraftBridgeHandler');
const { createTopupHandler } = require('./src/handlers/topupHandler');
const { registerEthergeonCitizenRoleEvents } = require('./src/handlers/ethergeonCitizenRoleHandler');
const {
  createModerationHandler,
  createModerationReactionHandler,
  syncActivePetitions
} = require('./src/handlers/moderationHandler');
const { createSubmissionStore } = require('./src/services/submissionStore');
const { createRegisterStore } = require('./src/services/registerStore');
const { createModerationStore } = require('./src/services/moderationStore');
const { createTopupBridgeService } = require('./src/services/topupBridgeService');
const { createTopupBridgeServer } = require('./src/services/topupBridgeServer');
const { createSociabuzzTopupService } = require('./src/services/sociabuzzTopupService');
const {
  REGISTER_ROLE_ID,
  LEGACY_ROLE_ID,
  MINECRAFT_REGISTER_ROLE_ID,
  MINECRAFT_REGISTER_PENDING_ROLE_ID,
  MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  TOPUP_BRIDGE_HOST,
  TOPUP_BRIDGE_PORT,
  TOPUP_BRIDGE_TOKEN,
  SOCIABUZZ_WEBHOOK_TOKEN,
} = require('./src/config');
const { isAllowedBotOutputChannel } = require('./src/utils/channelPolicy');

const LOCK_FILE = process.env.RIZEBOT_LOCK_FILE || path.join(os.tmpdir(), 'rizebot.lock');

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.pid === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // ignore lock cleanup issues
  }
}

function acquireLock() {
  const lockPayload = JSON.stringify({
    pid: process.pid,
    cwd: process.cwd(),
    startedAt: new Date().toISOString()
  });

  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(fd, lockPayload);
    fs.closeSync(fd);
    process.once('exit', releaseLock);
    process.once('SIGINT', () => {
      releaseLock();
      process.exit(130);
    });
    process.once('SIGTERM', () => {
      releaseLock();
      process.exit(143);
    });
    return;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }

  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (isProcessAlive(Number(data.pid))) {
      console.error(`Rizebot instance already running with pid ${data.pid}. Exiting.`);
      process.exit(1);
    }
  } catch {
    // stale or unreadable lock, replace it below
  }

  fs.rmSync(LOCK_FILE, { force: true });
  acquireLock();
}

acquireLock();

const client = new Client({
  intents: [
    I.Guilds,
    I.GuildMessages,
    I.MessageContent,
    I.GuildMembers,
    I.DirectMessages,
    I.GuildMessageReactions
  ],
  partials: [T.Message, T.Channel, T.Reaction, T.User]
});

const submissionStore = createSubmissionStore();
const legacyRegisterStore = createRegisterStore();
const moderationStore = createModerationStore();
const bridgeService = createTopupBridgeService({
  registerStore: legacyRegisterStore,
  client,
});
const sociabuzzTopupService = createSociabuzzTopupService({
  bridge: bridgeService,
  registerStore: legacyRegisterStore,
  client,
});
const bridgeServer = createTopupBridgeServer({
  bridge: bridgeService,
  host: TOPUP_BRIDGE_HOST,
  port: TOPUP_BRIDGE_PORT,
  token: TOPUP_BRIDGE_TOKEN,
  sociabuzz: sociabuzzTopupService,
  sociabuzzToken: SOCIABUZZ_WEBHOOK_TOKEN,
});
const registerHandler = createRegisterHandler({
  roleId: MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId: MINECRAFT_REGISTER_PENDING_ROLE_ID,
  rejectedRoleId: MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  registerStore: legacyRegisterStore,
  bridge: bridgeService,
  submissionStore
});
const registerInteractionHandler = createRegisterInteractionHandler({
  roleId: MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId: MINECRAFT_REGISTER_PENDING_ROLE_ID,
  rejectedRoleId: MINECRAFT_REGISTER_REJECTED_ROLE_ID,
  registerStore: legacyRegisterStore,
  bridge: bridgeService
});
const minecraftBridgeHandler = createMinecraftBridgeHandler({
  bridge: bridgeService,
  registerStore: legacyRegisterStore,
});
const topupHandler = createTopupHandler({
  bridge: bridgeService,
});
const moderationHandler = createModerationHandler({
  moderationStore,
  privateRoleId: REGISTER_ROLE_ID
});
const moderationReactionHandler = createModerationReactionHandler({
  moderationStore,
  privateRoleId: REGISTER_ROLE_ID
});

const baseHandleMessage = createMessageHandler({
  linkBlocker: maybeBlockLink,
  keywordReply: maybeReplyKeyword,
  registerHandler,
  moderationHandler,
  minecraftBridgeHandler,
  topupHandler
});

registerMemberEvents(client);
const privateRoleEvents = registerPrivateRoleEvents(client, {
  submissionStore,
  privateRoleId: REGISTER_ROLE_ID,
  legacyRoleId: LEGACY_ROLE_ID
});
const ethergeonCitizenRoleEvents = registerEthergeonCitizenRoleEvents(client, {
  registerStore: legacyRegisterStore,
  citizenRoleId: MINECRAFT_REGISTER_ROLE_ID,
  legacyRoleId: MINECRAFT_REGISTER_PENDING_ROLE_ID,
  rejectedRoleId: MINECRAFT_REGISTER_REJECTED_ROLE_ID
});

client.once('clientReady', async () => {
  await submissionStore.init(client).catch(err => {
    console.error('Failed to init submission store:', err);
  });
  await legacyRegisterStore.init(client).catch(err => {
    console.error('Failed to init legacy register store:', err);
  });
  await moderationStore.init(client).catch(err => {
    console.error('Failed to init moderation store:', err);
  });
  await privateRoleEvents.sync().catch(err => {
    console.error('Failed to sync private roles:', err);
  });
  await ethergeonCitizenRoleEvents.sync()
    .then(stats => {
      console.log(
        `Ethergeon Citizen role sync selesai. scanned=${stats.scanned}, migrated=${stats.migrated}, failed=${stats.failed}, skipped=${stats.skipped}, fromLegacyRole=${stats.fromLegacyRole || 0}, fromRegisterData=${stats.fromRegisterData || 0}`
      );
    })
    .catch(err => {
      console.error('Failed to sync Ethergeon Citizen roles:', err);
    });
  await syncActivePetitions(client, moderationStore).catch(err => {
    console.error('Failed to sync petitions:', err);
  });
  await bridgeServer.start()
    .then(() => {
      console.log(`Minecraft bridge server ready on ${TOPUP_BRIDGE_HOST}:${TOPUP_BRIDGE_PORT}`);
    })
    .catch(err => {
      console.error('Failed to start Minecraft bridge server:', err);
    });
  console.log(`バ. Bot ready as ${client.user.tag}`);
});

const processedMessageContent = new Map();
const PROCESSED_MESSAGE_TTL_MS = 5 * 60 * 1000;
const PROCESSED_MESSAGE_MAX = 1000;
const PROCESS_CLAIM_TTL_MS = 10 * 60 * 1000;
const PROCESS_CLAIM_PRUNE_MS = 60 * 1000;
const MESSAGE_CLAIM_DIR = process.env.RIZEBOT_MESSAGE_CLAIM_DIR ||
  path.join(os.tmpdir(), 'rizebot-message-claims');
let lastProcessClaimPruneAt = 0;

function pruneProcessedMessages(now = Date.now()) {
  for (const [messageId, entry] of processedMessageContent) {
    if (now - entry.at <= PROCESSED_MESSAGE_TTL_MS) continue;
    processedMessageContent.delete(messageId);
  }

  while (processedMessageContent.size > PROCESSED_MESSAGE_MAX) {
    const oldest = processedMessageContent.keys().next().value;
    if (!oldest) break;
    processedMessageContent.delete(oldest);
  }
}

function getMessageContent(msg) {
  return String(msg?.content || '');
}

function wasContentProcessed(msg) {
  if (!msg?.id) return false;
  pruneProcessedMessages();
  const entry = processedMessageContent.get(msg.id);
  return Boolean(entry && entry.content === getMessageContent(msg));
}

function rememberProcessedContent(msg) {
  if (!msg?.id) return;
  processedMessageContent.set(msg.id, {
    content: getMessageContent(msg),
    at: Date.now()
  });
  pruneProcessedMessages();
}

function safeMessageClaimId(messageId) {
  return String(messageId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

function pruneProcessClaims(now = Date.now()) {
  if (now - lastProcessClaimPruneAt < PROCESS_CLAIM_PRUNE_MS) return;
  lastProcessClaimPruneAt = now;

  let entries = [];
  try {
    entries = fs.readdirSync(MESSAGE_CLAIM_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const claimPath = path.join(MESSAGE_CLAIM_DIR, entry.name);
    try {
      const stat = fs.statSync(claimPath);
      if (now - stat.mtimeMs > PROCESS_CLAIM_TTL_MS) {
        fs.rmSync(claimPath, { recursive: true, force: true });
      }
    } catch {
      // Ignore stale claim cleanup errors.
    }
  }
}

function claimMessageAcrossProcesses(msg) {
  const messageId = safeMessageClaimId(msg?.id);
  if (!messageId) return false;

  const now = Date.now();
  try {
    fs.mkdirSync(MESSAGE_CLAIM_DIR, { recursive: true });
    pruneProcessClaims(now);
  } catch {
    return true;
  }

  const claimPath = path.join(MESSAGE_CLAIM_DIR, messageId);
  try {
    fs.mkdirSync(claimPath);
    fs.writeFileSync(path.join(claimPath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      content: getMessageContent(msg).slice(0, 200),
      createdAt: new Date(now).toISOString()
    }));
    return true;
  } catch (err) {
    if (err?.code !== 'EEXIST') return true;
  }

  try {
    const stat = fs.statSync(claimPath);
    if (now - stat.mtimeMs > PROCESS_CLAIM_TTL_MS) {
      fs.rmSync(claimPath, { recursive: true, force: true });
      return claimMessageAcrossProcesses(msg);
    }
  } catch {
    return true;
  }

  return false;
}

async function reloadLegacyRegisterDataFromMessage(msg) {
  const reloadedLegacyRegisterData = await legacyRegisterStore.reloadFromMessage(msg).catch(err => {
    console.error('Failed to reload legacy register data from message:', err);
    return false;
  });
  return reloadedLegacyRegisterData;
}

async function handleMessageCreate(msg) {
  if (await reloadLegacyRegisterDataFromMessage(msg)) return;
  if (wasContentProcessed(msg)) return;
  if (!claimMessageAcrossProcesses(msg)) return;
  rememberProcessedContent(msg);

  const handledSociabuzz = await sociabuzzTopupService.handleDiscordMessage(msg).catch(err => {
    console.error('Failed to process SociaBuzz message:', err);
    return false;
  });
  if (handledSociabuzz) return;

  if (!isAllowedBotOutputChannel(msg)) return;
  await baseHandleMessage(msg);
}

async function handleMessageUpdate(oldMsg, newMsg) {
  let msg = newMsg;
  if (msg?.partial) {
    msg = await msg.fetch().catch(() => null);
  }
  if (!msg) return;

  if (await reloadLegacyRegisterDataFromMessage(msg)) return;
  const handledSociabuzz = await sociabuzzTopupService.handleDiscordMessage(msg).catch(err => {
    console.error('Failed to process updated SociaBuzz message:', err);
    return false;
  });
  if (handledSociabuzz) return;

  if (!isAllowedBotOutputChannel(msg)) return;
  if (wasContentProcessed(msg)) return;

  const oldContent = oldMsg?.partial ? null : getMessageContent(oldMsg);
  const newContent = getMessageContent(msg);
  if (oldContent !== null && oldContent === newContent) return;

  await maybeBlockLink(msg);
  rememberProcessedContent(msg);
}

client.on('messageCreate', handleMessageCreate);
client.on('messageUpdate', handleMessageUpdate);
client.on('interactionCreate', async interaction => {
  const handledRegister = await registerInteractionHandler(interaction);
  if (handledRegister) return;
  const handledSociabuzz = await sociabuzzTopupService.handleInteraction(interaction).catch(err => {
    console.error('Failed to process SociaBuzz interaction:', err);
    return false;
  });
  if (handledSociabuzz) return;
  if (!isAllowedBotOutputChannel(interaction)) return;
});
client.on('messageReactionAdd', async (reaction, user) => {
  await moderationReactionHandler(reaction, user);
});

client.login(process.env.DISCORD_TOKEN);
