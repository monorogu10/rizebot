const { LINK_REGEX } = require('../config');
const { isAdmin } = require('../utils/permissions');

async function maybeBlockLink(msg) {
  try {
    if (!msg.guild || msg.author?.bot) return false;
    if (isAdmin(msg.member)) return false;

    if (LINK_REGEX.test(msg.content || '')) {
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
