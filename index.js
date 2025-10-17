require('dotenv').config();
const { Client, GatewayIntentBits: I, PermissionsBitField: P, Partials: T } = require('discord.js');

// === SIMPLE LINK BLOCKER (Admins Exempt) ===
const client = new Client({
  intents: [I.Guilds, I.GuildMessages, I.MessageContent, I.GuildMembers],
  partials: [T.Message, T.Channel]
});

// Basic HTTP/HTTPS URL detector (keeps it simple, case-insensitive)
const LINK_REGEX = /https?:\/\/\S+/i;

function isAdmin(member) {
  try { return member?.permissions?.has(P.Flags.Administrator); } catch { return false; }
}

async function handleLinkBlock(msg) {
  try {
    // Skip DMs, bots, or messages without guild/member context
    if (!msg.guild || msg.author?.bot) return;

    // Admins are exempt
    if (isAdmin(msg.member)) return;

    // If message contains a link, delete & warn
    if (LINK_REGEX.test(msg.content || '')) {
      await msg.delete().catch(() => {});
      const warn = await msg.channel.send(`${msg.author}, dilarang mengirim link di server ini.`).catch(() => null);
      if (warn) setTimeout(() => warn.delete().catch(() => {}), 5000);
    }
  } catch (e) {
    console.error('Link block error:', e);
  }
}

client.once('ready', () => {
  console.log(`✅ Link-block bot ready as ${client.user.tag}`);
});

client.on('messageCreate', handleLinkBlock);
client.on('messageUpdate', async (_old, n) => {
  if (n?.partial) { try { await n.fetch(); } catch {} }
  await handleLinkBlock(n);
});

client.login(process.env.DISCORD_TOKEN);
