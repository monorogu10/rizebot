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
const { createRegisterHandler } = require('./src/handlers/registerHandler');
const {
  createMinecraftRegisterHandler,
  createMinecraftRegisterInteractionHandler,
  syncMinecraftRegistrationRolesFromStore,
  syncMinecraftRoleForMember
} = require('./src/handlers/minecraftRegisterHandler');
const {
  createModerationHandler,
  createModerationReactionHandler,
  syncActivePetitions
} = require('./src/handlers/moderationHandler');
const { createSubmissionStore } = require('./src/services/submissionStore');
const { createRegisterStore } = require('./src/services/registerStore');
const { createModerationStore } = require('./src/services/moderationStore');
const { REGISTER_ROLE_ID, LEGACY_ROLE_ID, MINECRAFT_REGISTER_ROLE_ID } = require('./src/config');
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
const minecraftRegisterStore = createRegisterStore();
const moderationStore = createModerationStore();
const minecraftRegisterHandler = createMinecraftRegisterHandler({
  roleId: MINECRAFT_REGISTER_ROLE_ID,
  registerStore: minecraftRegisterStore
});
const minecraftRegisterInteractionHandler = createMinecraftRegisterInteractionHandler({
  registerStore: minecraftRegisterStore
});
const registerHandler = createRegisterHandler({
  roleId: REGISTER_ROLE_ID,
  submissionStore
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
  minecraftRegisterHandler,
  registerHandler,
  moderationHandler
});

registerMemberEvents(client);
const privateRoleEvents = registerPrivateRoleEvents(client, {
  submissionStore,
  privateRoleId: REGISTER_ROLE_ID,
  legacyRoleId: LEGACY_ROLE_ID
});

client.once('clientReady', async () => {
  await submissionStore.init(client).catch(err => {
    console.error('Failed to init submission store:', err);
  });
  await minecraftRegisterStore.init(client).catch(err => {
    console.error('Failed to init minecraft register store:', err);
  });
  await moderationStore.init(client).catch(err => {
    console.error('Failed to init moderation store:', err);
  });
  await privateRoleEvents.sync().catch(err => {
    console.error('Failed to sync private roles:', err);
  });
  await syncMinecraftRegistrationRolesFromStore(
    client,
    minecraftRegisterStore,
    MINECRAFT_REGISTER_ROLE_ID
  )
    .then(stats => {
      console.log(
        `Minecraft role sync selesai. scanned=${stats.scanned}, synced=${stats.synced}, failed=${stats.failed}, skipped=${stats.skipped}, duplicateEntriesRemoved=${stats.duplicateEntriesRemoved || 0}, duplicateRolesRemoved=${stats.duplicateRolesRemoved || 0}, duplicateRoleRemoveFailed=${stats.duplicateRoleRemoveFailed || 0}`
      );
    })
    .catch(err => {
      console.error('Failed to sync minecraft registration roles:', err);
    });
  await syncActivePetitions(client, moderationStore).catch(err => {
    console.error('Failed to sync petitions:', err);
  });
  console.log(`バ. Bot ready as ${client.user.tag}`);
});

const processedMessageContent = new Map();
const PROCESSED_MESSAGE_TTL_MS = 5 * 60 * 1000;
const PROCESSED_MESSAGE_MAX = 1000;

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

async function reloadMinecraftDataFromMessage(msg) {
  const reloadedMinecraftData = await minecraftRegisterStore.reloadFromMessage(msg).catch(err => {
    console.error('Failed to reload minecraft register data from message:', err);
    return false;
  });
  return reloadedMinecraftData;
}

async function handleMessageCreate(msg) {
  if (await reloadMinecraftDataFromMessage(msg)) return;
  if (!isAllowedBotOutputChannel(msg)) return;
  if (wasContentProcessed(msg)) return;
  rememberProcessedContent(msg);

  await baseHandleMessage(msg);
}

async function handleMessageUpdate(oldMsg, newMsg) {
  let msg = newMsg;
  if (msg?.partial) {
    msg = await msg.fetch().catch(() => null);
  }
  if (!msg) return;

  if (await reloadMinecraftDataFromMessage(msg)) return;
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
  if (!isAllowedBotOutputChannel(interaction)) return;
  const handledMinecraft = await minecraftRegisterInteractionHandler(interaction);
  if (handledMinecraft) return;
});
client.on('guildMemberAdd', async member => {
  await syncMinecraftRoleForMember(
    member,
    minecraftRegisterStore,
    MINECRAFT_REGISTER_ROLE_ID
  ).catch(err => {
    console.error('Failed to sync minecraft role for joined member:', err);
  });
});
client.on('messageReactionAdd', async (reaction, user) => {
  await moderationReactionHandler(reaction, user);
});

client.login(process.env.DISCORD_TOKEN);
