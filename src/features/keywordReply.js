const { KEYWORD_CHANNELS, KEYWORD_REGEX } = require('../config');

const repliedKeywordMsgIds = new Set();

async function maybeReplyKeyword(msg) {
  try {
    if (!msg.guild || msg.author?.bot) return false;
    if (!KEYWORD_CHANNELS.has(String(msg.channelId))) return false;

    const text = (msg.content || '').trim();
    if (!KEYWORD_REGEX.test(text)) return false;
    if (repliedKeywordMsgIds.has(msg.id)) return false;

    repliedKeywordMsgIds.add(msg.id);
    const dm = await msg.author
      .send('Unduh addon monoDeco terbaru di situs resmi: https://monodeco.my.id/')
      .catch(() => null);
    if (dm) setTimeout(() => dm.delete().catch(() => {}), 5000);
    return true;
  } catch (err) {
    console.error('Keyword reply error:', err);
    return false;
  }
}

module.exports = { maybeReplyKeyword };
