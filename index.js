require('dotenv').config();
const { Client, GatewayIntentBits: I, Partials: T } = require('discord.js');

const { maybeBlockLink } = require('./src/features/linkBlocker');
const { maybeReplyKeyword } = require('./src/features/keywordReply');
const { createLeaderboardStore } = require('./src/services/leaderboardStore');
const { handleAdminCommands } = require('./src/commands/adminCommands');
const { handleStatusCommand } = require('./src/commands/statusCommand');
const { createMessageHandler } = require('./src/handlers/messageHandler');

const client = new Client({
  intents: [I.Guilds, I.GuildMessages, I.MessageContent, I.GuildMembers],
  partials: [T.Message, T.Channel]
});

const leaderboardStore = createLeaderboardStore();

const baseHandleMessage = createMessageHandler({
  linkBlocker: maybeBlockLink,
  keywordReply: maybeReplyKeyword,
  adminCommands: msg => handleAdminCommands(msg, leaderboardStore),
  statusCommand: msg => handleStatusCommand(msg, leaderboardStore)
});

let resolveStoreReady;
const storeReadyPromise = new Promise(res => { resolveStoreReady = res; });

client.once('ready', async () => {
  console.log(`バ. Bot ready as ${client.user.tag}`);
  try {
    await leaderboardStore.init(client);
    console.log('Leaderboard data loaded dari channel save (jika ada).');
  } finally {
    resolveStoreReady();
  }
});

async function handleMessage(msg) {
  await storeReadyPromise;
  await baseHandleMessage(msg);
}

client.on('messageCreate', handleMessage);
client.on('messageUpdate', async (_old, n) => {
  if (n?.partial) {
    try { await n.fetch(); } catch { /* ignore */ }
  }
  await handleMessage(n);
});

client.login(process.env.DISCORD_TOKEN);
