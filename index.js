require('dotenv').config();
const { Client, GatewayIntentBits: I, Partials: T } = require('discord.js');

const { maybeBlockLink } = require('./src/features/linkBlocker');
const { maybeReplyKeyword } = require('./src/features/keywordReply');
const { createMessageHandler } = require('./src/handlers/messageHandler');
const { registerMemberEvents } = require('./src/handlers/memberEvents');
const { createRegisterHandler, createSubmissionReactionHandler } = require('./src/handlers/registerHandler');
const { REGISTER_ROLE_ID } = require('./src/config');

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

const registerHandler = createRegisterHandler({
  roleId: REGISTER_ROLE_ID
});
const submissionReactionHandler = createSubmissionReactionHandler({
  roleId: REGISTER_ROLE_ID
});

const baseHandleMessage = createMessageHandler({
  linkBlocker: maybeBlockLink,
  keywordReply: maybeReplyKeyword,
  registerHandler
});

registerMemberEvents(client);

client.once('ready', () => {
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
client.on('messageReactionAdd', async (reaction, user) => {
  await submissionReactionHandler(reaction, user);
});

client.login(process.env.DISCORD_TOKEN);
