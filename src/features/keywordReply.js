const { KEYWORD_LINKS } = require('../config');

const repliedKeywordMessages = new Map();
const MEMBER_COMMAND = '!member';
const REPLY_DEDUPE_TTL_MS = 5 * 60 * 1000;
const REPLY_DEDUPE_MAX = 1000;
const CLAIM_LAND_TUTORIAL_URL = 'https://www.youtube.com/shorts/DkJUHpTXktg';
const MAGIC_TOOL_TUTORIAL_URL = 'https://www.youtube.com/shorts/wHzqhw7TdQ0';
const TOPUP_SUPPORT_URL = 'https://sociabuzz.com/monodeco/support';
const HOW_TO_WORDS = new Set([
  'cara',
  'gimana',
  'gmn',
  'bagaimana',
  'tutorial',
  'tutor',
  'pake',
  'pakai',
  'make',
  'menggunakan',
  'gunakan',
  'guna',
  'use',
  'how'
]);
const TOPUP_WORDS = new Set([
  'topup',
  'top',
  'up',
  'donasi',
  'donate',
  'support',
  'sociabuzz',
  'geon'
]);
const TOPUP_INTENT_WORDS = new Set([
  'cara',
  'gimana',
  'gmn',
  'bagaimana',
  'mau',
  'ingin',
  'beli',
  'isi',
  'cek',
  'berapa',
  'rate',
  'kurs',
  'harga',
  'link',
  'min',
  'admin',
  'topup',
  'donasi',
  'donate',
  'support'
]);

function pruneRepliedKeywordMessages(now = Date.now()) {
  for (const [messageId, entry] of repliedKeywordMessages) {
    if (now - entry.at <= REPLY_DEDUPE_TTL_MS) continue;
    repliedKeywordMessages.delete(messageId);
  }

  while (repliedKeywordMessages.size > REPLY_DEDUPE_MAX) {
    const oldest = repliedKeywordMessages.keys().next().value;
    if (!oldest) break;
    repliedKeywordMessages.delete(oldest);
  }
}

function hasRepliedKeyword(msg, text) {
  if (!msg?.id) return false;
  pruneRepliedKeywordMessages();
  const entry = repliedKeywordMessages.get(msg.id);
  return Boolean(entry && entry.text === text);
}

function rememberKeywordReply(msg, text) {
  if (!msg?.id) return;
  repliedKeywordMessages.set(msg.id, {
    text,
    at: Date.now()
  });
  pruneRepliedKeywordMessages();
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function hasAnyToken(tokens, values) {
  return values.some(value => tokens.includes(value));
}

function hasHowToIntent(tokens) {
  return tokens.some(token => HOW_TO_WORDS.has(token));
}

function findTutorialReply(text) {
  const tokens = tokenize(text);
  const compact = tokens.join('');

  const mentionsClaim = hasAnyToken(tokens, ['claim', 'klaim']);
  const mentionsLand = hasAnyToken(tokens, ['land', 'tanah']);
  if (mentionsClaim && mentionsLand) {
    return {
      name: 'claim land',
      url: CLAIM_LAND_TUTORIAL_URL
    };
  }

  const mentionsMagicTool = tokens.includes('mt') ||
    compact.includes('magictool') ||
    (tokens.includes('magic') && tokens.includes('tool'));
  if (mentionsMagicTool && hasHowToIntent(tokens)) {
    return {
      name: 'Magic Tool',
      url: MAGIC_TOOL_TUTORIAL_URL
    };
  }

  return null;
}

function findTopupReply(text) {
  const tokens = tokenize(text);
  const compact = tokens.join('');
  const mentionsTopup =
    tokens.some(token => TOPUP_WORDS.has(token)) ||
    compact.includes('topup') ||
    compact.includes('isigeon') ||
    compact.includes('beligeon') ||
    compact.includes('donasi') ||
    compact.includes('sociabuzz');

  if (!mentionsTopup) return null;

  const hasIntent =
    tokens.some(token => TOPUP_INTENT_WORDS.has(token)) ||
    hasHowToIntent(tokens) ||
    compact === 'topup' ||
    compact === 'donasi' ||
    compact === 'support';

  if (!hasIntent) return null;

  return [
    `Topup Geon lewat: ${TOPUP_SUPPORT_URL}`,
    'Saat isi SociaBuzz, tulis GAMERTAG MINECRAFT kamu dengan jelas di nama dan pesan. Jangan typo.',
    'Contoh pesan: `GT: NamaMinecraft | DC: username_discord`',
    'Cek kurs dengan `/geonrate rupiah:<nominal>`.'
  ].join('\n');
}

async function maybeReplyKeyword(msg) {
  try {
    if (!msg.guild || msg.author?.bot) return false;

    const text = (msg.content || '').trim().toLowerCase();
    if (hasRepliedKeyword(msg, text)) return false;

    if (text === MEMBER_COMMAND) {
      rememberKeywordReply(msg, text);
      const total = Number(msg.guild?.memberCount) || 0;
      await msg.reply(`Total member saat ini: ${total}`).catch(() => null);
      return true;
    }

    const tutorial = findTutorialReply(text);
    if (tutorial) {
      rememberKeywordReply(msg, text);
      await msg.reply(`Tonton tutorial ${tutorial.name} ini dulu ya: ${tutorial.url}`).catch(() => null);
      return true;
    }

    const topupReply = findTopupReply(text);
    if (topupReply) {
      rememberKeywordReply(msg, text);
      await msg.reply(topupReply).catch(() => null);
      return true;
    }

    const normalized = text.replace(/[^a-z0-9]/g, '');
    if (!Object.prototype.hasOwnProperty.call(KEYWORD_LINKS, normalized)) return false;
    const link = KEYWORD_LINKS[normalized];

    rememberKeywordReply(msg, text);
    await msg.reply(`Silakan cek: ${link}`).catch(() => null);
    return true;
  } catch (err) {
    console.error('Keyword reply error:', err);
    return false;
  }
}

module.exports = { maybeReplyKeyword };
