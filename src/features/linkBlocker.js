const { ALLOWED_GIF_HOSTS, LINK_REGEX } = require('../config');
const { isAdmin } = require('../utils/permissions');

const LINK_EXTRACT_REGEX = /https?:\/\/\S+/gi;

function normalizeHost(hostname = '') {
  const lower = hostname.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
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

async function maybeBlockLink(msg) {
  try {
    if (!msg.guild || msg.author?.bot) return false;
    if (isAdmin(msg.member)) return false;

    if (LINK_REGEX.test(msg.content || '')) {
      if (isGifOnlyMessage(msg)) return false;

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
