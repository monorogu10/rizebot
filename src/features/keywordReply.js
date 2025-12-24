const { KEYWORD_LINKS } = require('../config');

const repliedKeywordMsgIds = new Set();

async function maybeReplyKeyword(msg) {
  try {
    if (!msg.guild || msg.author?.bot) return false;

    const text = (msg.content || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(KEYWORD_LINKS, text)) return false;
    const link = KEYWORD_LINKS[text];
    if (repliedKeywordMsgIds.has(msg.id)) return false;

    repliedKeywordMsgIds.add(msg.id);
    await msg.reply(`Silakan cek: ${link}`).catch(() => null);
    return true;
  } catch (err) {
    console.error('Keyword reply error:', err);
    return false;
  }
}

module.exports = { maybeReplyKeyword };
