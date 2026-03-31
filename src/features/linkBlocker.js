const { ALLOWED_GIF_HOSTS, LINK_REGEX } = require('../config');
const { isAdmin } = require('../utils/permissions');

const LINK_EXTRACT_REGEX = /https?:\/\/\S+/gi;

// ── Discord invite patterns (with or without protocol) ──────────────
// Matches: discord.gg/CODE, discord.com/invite/CODE, discordapp.com/invite/CODE
// Also catches: www.discord.gg/CODE, https://discord.gg/CODE, etc.
const DISCORD_INVITE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/gi;

// ── Bare-domain link detection (no protocol) ────────────────────────
// Catches things like: example.com, sub.example.com/path, bit.ly/xyz
// Common TLDs that people actually use to share links
const BARE_LINK_TLDS = [
  'com', 'net', 'org', 'io', 'gg', 'me', 'co', 'us', 'info',
  'xyz', 'app', 'dev', 'ly', 'to', 'cc', 'tv', 'id', 'link',
  'site', 'online', 'store', 'shop', 'club', 'pro', 'tech',
  'space', 'fun', 'live', 'world', 'click', 'top', 'in',
  'uk', 'de', 'fr', 'jp', 'kr', 'ru', 'br', 'au', 'ca'
];
const TLD_GROUP = BARE_LINK_TLDS.join('|');
// Matches: word.tld, word.word.tld, word.tld/path  (but NOT inside protocol URLs)
const BARE_LINK_REGEX = new RegExp(
  `(?<![:/])\\b[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\\.(?:${TLD_GROUP})(?:\\/\\S*)?\\b`,
  'gi'
);

// ── Whitelist – hosts that are always allowed ────────────────────────
const ALLOWED_HOSTS = new Set([
  ...ALLOWED_GIF_HOSTS,
  // Add any other whitelisted domains here
]);

function normalizeHost(hostname = '') {
  const lower = hostname.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

function isAllowedHost(raw) {
  try {
    // Make sure we have a protocol so URL() can parse it
    const withProto = raw.startsWith('http') ? raw : `https://${raw}`;
    const url = new URL(withProto);
    const host = normalizeHost(url.hostname);
    for (const allowed of ALLOWED_HOSTS) {
      if (host === allowed || host.endsWith(`.${allowed}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isAllowedGifLink(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = normalizeHost(url.hostname);
    const path = (url.pathname || '').toLowerCase();
    if (path.endsWith('.gif') || path.endsWith('.gifv')) return true;
    for (const allowed of ALLOWED_GIF_HOSTS) {
      if (host === allowed || host.endsWith(`.${allowed}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isGifOnlyMessage(msg) {
  const text = msg.content || '';
  const links = text.match(LINK_EXTRACT_REGEX) || [];
  const hasLinks = links.length > 0;
  if (!hasLinks) return false;

  return links.every(isAllowedGifLink);
}

/**
 * Check if a message contains a Discord server invite link.
 * Works with and without http(s):// prefix.
 */
function containsDiscordInvite(text) {
  return DISCORD_INVITE_REGEX.test(text);
}

/**
 * Check if a message contains bare-domain links (without protocol).
 * Returns an array of matched bare links, excluding whitelisted hosts.
 */
function findBareLinks(text) {
  const matches = text.match(BARE_LINK_REGEX) || [];
  return matches.filter(m => !isAllowedHost(m));
}

async function maybeBlockLink(msg) {
  try {
    if (!msg.guild || msg.author?.bot) return false;
    if (isAdmin(msg.member)) return false;

    const text = msg.content || '';

    // ── 1. Discord invite links (top priority – always blocked) ──
    // Reset lastIndex for global regex
    DISCORD_INVITE_REGEX.lastIndex = 0;
    if (containsDiscordInvite(text)) {
      await msg.delete().catch(() => {});
      const warn = await msg.channel
        .send(`${msg.author}, dilarang mengirim link invite Discord di server ini.`)
        .catch(() => null);
      if (warn) setTimeout(() => warn.delete().catch(() => {}), 5000);
      return true;
    }

    // ── 2. Standard http(s) links ────────────────────────────────
    if (LINK_REGEX.test(text)) {
      if (isGifOnlyMessage(msg)) return false;

      await msg.delete().catch(() => {});
      const warn = await msg.channel
        .send(`${msg.author}, dilarang mengirim link di server ini.`)
        .catch(() => null);
      if (warn) setTimeout(() => warn.delete().catch(() => {}), 5000);
      return true;
    }

    // ── 3. Bare-domain links (no protocol) ───────────────────────
    const bareLinks = findBareLinks(text);
    if (bareLinks.length > 0) {
      await msg.delete().catch(() => {});
      const warn = await msg.channel
        .send(`${msg.author}, dilarang mengirim link di server ini.`)
        .catch(() => null);
      if (warn) setTimeout(() => warn.delete().catch(() => {}), 5000);
      return true;
    }
  } catch (err) {
    console.error('Link block error:', err);
  }
  return false;
}

module.exports = { maybeBlockLink };
