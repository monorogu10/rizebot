const { KEYWORD_LINKS } = require('../config');

const repliedKeywordMsgIds = new Set();
const MEMBER_COMMAND = '!member';

async function maybeReplyKeyword(msg) {
  try {
    if (!msg.guild || msg.author?.bot) return false;

    const text = (msg.content || '').trim().toLowerCase();
    if (repliedKeywordMsgIds.has(msg.id)) return false;

    if (text === MEMBER_COMMAND) {
      repliedKeywordMsgIds.add(msg.id);
      const total = Number(msg.guild?.memberCount) || 0;
      await msg.reply(`Total member saat ini: ${total}`).catch(() => null);
      return true;
    }

    const normalized = text.replace(/[^a-z0-9]/g, '');
    if (!Object.prototype.hasOwnProperty.call(KEYWORD_LINKS, normalized)) return false;
    const link = KEYWORD_LINKS[normalized];

    repliedKeywordMsgIds.add(msg.id);
    await msg.reply(`Silakan cek: ${link}`).catch(() => null);
    return true;
  } catch (err) {
    console.error('Keyword reply error:', err);
    return false;
  }
}

module.exports = { maybeReplyKeyword };
