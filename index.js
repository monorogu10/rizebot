require('dotenv').config();
const { Client, GatewayIntentBits: I, PermissionsBitField: P, Partials: T } = require('discord.js');

// === SIMPLE LINK BLOCKER (Admins Exempt) ===
const client = new Client({
  intents: [I.Guilds, I.GuildMessages, I.MessageContent, I.GuildMembers],
  partials: [T.Message, T.Channel]
});


// Basic HTTP/HTTPS URL detector (keeps it simple, case-insensitive)
const LINK_REGEX = /https?:\/\/\S+/i;

// Channel whitelist for keyword reply
const KEYWORD_CHANNELS = new Set(['1412299373731385354','1411683951575040160','1209816094156529745']);
// Keywords that trigger the official download link (must be the only word)
const KEYWORD_REGEX = /^(?:monodeco|decorize|mdco)$/i;
// Track messages we've already replied to (avoid double reply on edits)
const repliedKeywordMsgIds = new Set();

function isAdmin(member) {
  try { return member?.permissions?.has(P.Flags.Administrator); } catch { return false; }
}

async function maybeBlockLink(msg) {
  try {
    // Skip DMs, bots, or messages without guild/member context
    if (!msg.guild || msg.author?.bot) return false;

    // Admins are exempt
    if (isAdmin(msg.member)) return false;

    // If message contains a link, delete & warn
    if (LINK_REGEX.test(msg.content || '')) {
      await msg.delete().catch(() => {});
      const warn = await msg.channel
        .send(`${msg.author}, dilarang mengirim link di server ini.`)
        .catch(() => null);
      if (warn) setTimeout(() => warn.delete().catch(() => {}), 5000);
      return true; // deleted
    }
  } catch (e) {
    console.error('Link block error:', e);
  }
  return false;
}

async function maybeReplyKeyword(msg) {
  try {
    if (!msg.guild || msg.author?.bot) return;
    if (!KEYWORD_CHANNELS.has(String(msg.channelId))) return;

    const text = (msg.content || '').trim();
    if (!KEYWORD_REGEX.test(text)) return;

    // Avoid duplicate replies for the same message (e.g., after an edit)
    if (repliedKeywordMsgIds.has(msg.id)) return;
    repliedKeywordMsgIds.add(msg.id);

    // Send a private, self-destructing reply to the author only
    const dm = await msg.author
      .send('Unduh addon monoDeco terbaru di situs resmi: https://monodeco.my.id/')
      .catch(() => null);
    if (dm) setTimeout(() => dm.delete().catch(() => {}), 5000);
  } catch (e) {
    console.error('Keyword reply error:', e);
  }
}

async function handleMessage(msg) {
  // First: block links if needed. If we deleted the message, stop.
  const deleted = await maybeBlockLink(msg);
  if (deleted) return;
  // Then: keyword auto-reply (only in whitelisted channels)
  await maybeReplyKeyword(msg);
}

client.once('ready', () => {
  console.log(`✅ Link-block bot ready as ${client.user.tag}`);
});

client.on('messageCreate', handleMessage);
client.on('messageUpdate', async (_old, n) => {
  if (n?.partial) { try { await n.fetch(); } catch {} }
  await handleMessage(n);
});

client.login(process.env.DISCORD_TOKEN);
