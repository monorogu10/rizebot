require('dotenv').config();
const { Client, GatewayIntentBits: I, Partials: T } = require('discord.js');

const { maybeBlockLink } = require('./src/features/linkBlocker');
const { maybeReplyKeyword } = require('./src/features/keywordReply');
const { createMessageHandler } = require('./src/handlers/messageHandler');

const client = new Client({
  intents: [I.Guilds, I.GuildMessages, I.MessageContent, I.GuildMembers],
  partials: [T.Message, T.Channel]
});


const baseHandleMessage = createMessageHandler({
  linkBlocker: maybeBlockLink,
  keywordReply: maybeReplyKeyword
});

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

client.login(process.env.DISCORD_TOKEN);
