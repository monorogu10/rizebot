require('dotenv').config();
const { Client, GatewayIntentBits: I, Partials: T } = require('discord.js');

const { maybeBlockLink } = require('./src/features/linkBlocker');
const { maybeReplyKeyword } = require('./src/features/keywordReply');
const { createMessageHandler } = require('./src/handlers/messageHandler');
const { registerMemberEvents } = require('./src/handlers/memberEvents');
const { createRegisterStore } = require('./src/services/registerStore');
const { createRegisterHandler } = require('./src/handlers/registerHandler');
const { REGISTER_ROLE_ID, REGISTRATION_INBOX_CHANNEL_ID } = require('./src/config');

const client = new Client({
  intents: [I.Guilds, I.GuildMessages, I.MessageContent, I.GuildMembers, I.DirectMessages],
  partials: [T.Message, T.Channel]
});

const registerStore = createRegisterStore();
const registerHandler = createRegisterHandler({
  registerStore,
  roleId: REGISTER_ROLE_ID,
  inboxChannelId: REGISTRATION_INBOX_CHANNEL_ID
});

const baseHandleMessage = createMessageHandler({
  linkBlocker: maybeBlockLink,
  keywordReply: maybeReplyKeyword,
  registerHandler
});

registerMemberEvents(client);

client.once('ready', async () => {
  await registerStore.init(client).catch(err => {
    console.error('Failed to init register store:', err);
  });
  console.log(`バ. Bot ready as ${client.user.tag}`);
});

async function handleMessage(msg) {
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
