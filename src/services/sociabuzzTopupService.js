const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const {
  SOCIABUZZ_SOURCE_CHANNEL_IDS,
  SOCIABUZZ_TOPUP_LOG_CHANNEL_ID,
  TOPUP_ADMIN_DISCORD_ID,
} = require('../config');

const RUNTIME_DIR = process.env.RIZEBOT_RUNTIME_DIR ||
  path.join(__dirname, '..', '..', '.runtime');
const STORE_FILE = process.env.SOCIABUZZ_TOPUP_STORE_FILE ||
  path.join(RUNTIME_DIR, 'sociabuzz-topups.json');
const BUTTON_PREFIX = 'sbtu';
const MAX_CANDIDATES = 5;
const PAYMENT_STORE_LIMIT = 1000;
const FUZZY_SCORE_MAX = 2;
const UNKNOWN_NAMES = new Set([
  'someone',
  'anonymous',
  'anonim',
  'unknown',
  'tidak diketahui',
  'tanpa nama',
  'orang baik',
]);
const IDENTITY_LABELS = [
  'GT',
  'GAMERTAG',
  'MC',
  'MINECRAFT',
  'IGN',
  'DC',
  'DISCORD',
  'DISCORD ID',
  'DISCORD USER',
];

const RATE_TIERS = [
  { rupiah: 1000, geon: 100 },
  { rupiah: 10000, geon: 1000 },
  { rupiah: 20000, geon: 2500 },
  { rupiah: 50000, geon: 10000 },
  { rupiah: 100000, geon: 50000 },
];

function n(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function compact(value, maxLength = 1800) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeAmount(rawValue) {
  const digits = String(rawValue || '').replace(/[^\d]/g, '');
  if (!digits) return 0;
  const value = Math.floor(Number(digits));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function formatNumber(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function rupiahText(value) {
  return `Rp${formatNumber(value)}`;
}

function calculateGeon(rupiahRaw) {
  const rupiah = Math.max(0, Math.floor(Number(rupiahRaw) || 0));
  if (!rupiah) return 0;
  const tiers = RATE_TIERS;
  if (rupiah <= tiers[0].rupiah) {
    return Math.max(1, Math.floor(rupiah * (tiers[0].geon / tiers[0].rupiah)));
  }

  for (let index = 1; index < tiers.length; index += 1) {
    const prev = tiers[index - 1];
    const next = tiers[index];
    if (rupiah > next.rupiah) continue;

    const progress = (rupiah - prev.rupiah) / (next.rupiah - prev.rupiah);
    return Math.max(1, Math.floor(prev.geon + progress * (next.geon - prev.geon)));
  }

  const highest = tiers[tiers.length - 1];
  return Math.max(1, Math.floor(rupiah * (highest.geon / highest.rupiah)));
}

function paymentRecordId(sourceKey) {
  return `sb_${crypto.createHash('sha1').update(String(sourceKey || '')).digest('hex').slice(0, 16)}`;
}

function embedToParts(embed) {
  const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed;
  const fields = Array.isArray(data?.fields)
    ? data.fields.map(field => `${field.name || ''}: ${field.value || ''}`)
    : [];
  return {
    title: compact(data?.title || ''),
    description: compact(data?.description || '', 3000),
    author: compact(data?.author?.name || ''),
    footer: compact(data?.footer?.text || ''),
    url: compact(data?.url || ''),
    fields,
  };
}

function sourceFromDiscordMessage(msg) {
  const embeds = Array.isArray(msg?.embeds) ? msg.embeds.map(embedToParts) : [];
  return {
    kind: 'discord',
    sourceKey: `discord:${msg.id}`,
    messageId: String(msg.id || ''),
    channelId: String(msg.channelId || msg.channel?.id || ''),
    authorId: String(msg.author?.id || ''),
    authorTag: compact(msg.author?.tag || msg.author?.username || '', 120),
    content: compact(msg.content || '', 3000),
    embeds,
    createdAt: new Date(msg.createdTimestamp || Date.now()).toISOString(),
    messageUrl: msg.url || '',
  };
}

function flattenPayload(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) return value.flatMap(item => flattenPayload(item, depth + 1));
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [key, ...flattenPayload(item, depth + 1)]);
  }
  return [];
}

function sourceFromWebhookPayload(payload = {}) {
  const externalId = compact(
    payload.id ||
    payload.payment_id ||
    payload.transaction_id ||
    payload.order_id ||
    payload.invoice_id ||
    payload.reference ||
    payload.created_at ||
    JSON.stringify(payload).slice(0, 200),
    240
  );
  return {
    kind: 'webhook',
    sourceKey: `webhook:${externalId}`,
    messageId: '',
    channelId: '',
    authorId: 'sociabuzz-webhook',
    authorTag: 'SociaBuzz Webhook',
    content: [
      flattenPayload(payload).join('\n'),
      JSON.stringify(payload),
    ].join('\n').slice(0, 5000),
    embeds: [],
    createdAt: new Date().toISOString(),
    messageUrl: '',
  };
}

function textForParsing(source) {
  const embedDescriptions = source.embeds.map(embed => embed.description).filter(Boolean).join('\n');
  const embedFields = source.embeds.flatMap(embed => embed.fields).join('\n');
  const embedTitles = source.embeds.map(embed => embed.title).filter(Boolean).join('\n');
  const embedMeta = source.embeds.map(embed => [embed.author, embed.footer, embed.url].filter(Boolean).join('\n')).join('\n');
  const primaryText = [source.content, embedDescriptions, embedFields].filter(Boolean).join('\n');
  const fallbackText = [embedTitles, embedMeta].filter(Boolean).join('\n');
  return {
    primaryText,
    fallbackText,
    allText: [primaryText, fallbackText].filter(Boolean).join('\n'),
  };
}

function looksLikeSociabuzzPayment(source) {
  const text = textForParsing(source).allText;
  if (!text) return false;
  const lower = text.toLowerCase();
  const hasAmount = /\b(?:idr|rp|rupiah)\s*[\d.,]+/i.test(text) ||
    /"(?:amount|nominal|total|price|gross_amount)"\s*:\s*"?[0-9][0-9.,]*/i.test(text);
  const hasSignal = source.kind === 'webhook' ||
    /sociabuzz|monocrowdfunding|dana sebesar|investor|tribe|donasi|support/i.test(lower);
  return hasAmount && hasSignal;
}

function extractRupiah(text) {
  const patterns = [
    /\b(?:idr|rp\.?|rupiah)\s*([0-9][0-9.,]*)/i,
    /\b([0-9][0-9.,]*)\s*(?:idr|rp|rupiah)\b/i,
    /"(?:amount|nominal|total|price|gross_amount)"\s*:\s*"?([0-9][0-9.,]*)/i,
    /\b(?:amount|nominal|total|price|gross_amount)\b\s*[:=]\s*([0-9][0-9.,]*)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const amount = normalizeAmount(match?.[1]);
    if (amount) return amount;
  }
  return 0;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelPattern(labels) {
  return labels.map(escapeRegExp).join('|');
}

function extractLabel(text, labels, stopLabels = IDENTITY_LABELS) {
  const label = labelPattern(labels);
  const stops = ['[|\\n\\r;,]', '$'];
  if (Array.isArray(stopLabels) && stopLabels.length) {
    stops.unshift(`\\s+(?:${labelPattern(stopLabels)})\\s*[:=\\-]`);
  }
  const pattern = new RegExp(`(?:^|[\\s|,;])(?:${label})\\s*[:=\\-]\\s*([\\s\\S]*?)(?=${stops.join('|')})`, 'i');
  const match = text.match(pattern);
  return compact(match?.[1] || '', 80);
}

function extractDonorFromTitle(text) {
  const patterns = [
    /\bdari\s+(?:investor|supporter|donatur|user)?\s*([^\n\r|]+)/i,
    /\binvestor\s+([^\n\r|]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const donor = compact(match?.[1] || '', 80)
      .replace(/\b(today|yesterday|at|pukul)\b.*$/i, '')
      .trim();
    if (donor) return donor;
  }
  return '';
}

function normalizeDiscordHandle(raw) {
  return compact(raw, 80)
    .replace(/^@+/, '')
    .replace(/\s+#\d{4}$/, '')
    .trim();
}

function extractIdentity(source) {
  const { primaryText, fallbackText, allText } = textForParsing(source);
  const mention = allText.match(/<@!?(\d{15,25})>/)?.[1] || '';
  const gamertag = extractLabel(primaryText, ['GT', 'GAMERTAG', 'MC', 'MINECRAFT', 'IGN']);
  const discord = normalizeDiscordHandle(
    extractLabel(primaryText, ['DC', 'DISCORD', 'DISCORD ID', 'DISCORD USER'])
  );
  const donor = extractDonorFromTitle(fallbackText);

  return {
    mention,
    gamertag,
    discord,
    donor,
    primaryText: compact(primaryText, 900),
    fallbackText: compact(fallbackText, 900),
  };
}

function sameText(left, right) {
  return n(left) === n(right);
}

function usernameMatches(entry, queryRaw) {
  const query = n(normalizeDiscordHandle(queryRaw));
  if (!query) return false;
  const username = n(normalizeDiscordHandle(entry.username || ''));
  return Boolean(username && username === query);
}

function candidateFromEntry(entry, reason, confidence, score = 0) {
  return {
    userId: String(entry.userId || ''),
    gamertag: compact(entry.gamertag || '', 80),
    username: compact(entry.username || '', 120),
    verified: Boolean(entry.verified),
    reason,
    confidence,
    score,
  };
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = candidate.userId || n(candidate.gamertag);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result.slice(0, MAX_CANDIDATES);
}

function findCandidates(registerStore, identity) {
  const entries = registerStore.getEntries();
  const candidates = [];

  if (identity.mention) {
    const entry = registerStore.getUser(identity.mention);
    if (entry) candidates.push(candidateFromEntry({ ...entry, userId: identity.mention }, 'discord mention/id exact', 'exact', 0));
  }

  if (identity.gamertag) {
    const linked = registerStore.findUserByGamertag?.(identity.gamertag);
    if (linked?.entry) {
      candidates.push(candidateFromEntry({ ...linked.entry, userId: linked.userId }, 'GT exact', 'exact', 0));
    }
  }

  if (identity.discord) {
    const exactDiscord = entries.filter(entry => usernameMatches(entry, identity.discord));
    for (const entry of exactDiscord) {
      candidates.push(candidateFromEntry(entry, 'Discord name exact', 'exact', 0));
    }
  }

  const fuzzyQueries = [identity.gamertag, identity.discord, identity.donor]
    .map(value => compact(value, 80))
    .filter(value => value && !UNKNOWN_NAMES.has(n(value)));
  for (const query of fuzzyQueries) {
    const scored = entries
      .map(entry => ({
        entry,
        score: Math.min(
          targetScore(entry, query),
          usernameMatches(entry, query) ? 0 : 99
        ),
      }))
      .filter(item => item.score <= FUZZY_SCORE_MAX)
      .sort((a, b) => a.score - b.score || a.entry.gamertag.localeCompare(b.entry.gamertag))
      .slice(0, MAX_CANDIDATES);
    for (const item of scored) {
      candidates.push(candidateFromEntry(item.entry, `search: ${query}`, item.score === 0 ? 'exact' : 'fuzzy', item.score));
    }
  }

  return dedupeCandidates(candidates);
}

function targetScore(entry, rawQuery) {
  const query = n(rawQuery);
  const gamertag = n(entry.gamertag);
  const username = n(entry.username);
  const userId = String(entry.userId || '');
  if (!query) return 99;
  if (gamertag === query || username === query || userId === query) return 0;
  if (gamertag.startsWith(query) || username.startsWith(query)) return 1;
  if (gamertag.includes(query) || username.includes(query) || userId.includes(query)) return 2;
  return 99;
}

function exactAutoCandidate(candidates) {
  const exact = candidates.filter(candidate => candidate.confidence === 'exact');
  if (exact.length !== 1) return null;
  return exact[0];
}

function parsePayment(source, registerStore) {
  if (!looksLikeSociabuzzPayment(source)) return null;
  const { allText } = textForParsing(source);
  const rupiah = extractRupiah(allText);
  if (!rupiah) return null;
  const geon = calculateGeon(rupiah);
  const identity = extractIdentity(source);
  const candidates = findCandidates(registerStore, identity);
  const autoCandidate = exactAutoCandidate(candidates);
  const reason = autoCandidate
    ? 'exact-match'
    : (candidates.length ? 'needs-review' : 'no-candidate');

  return {
    id: paymentRecordId(source.sourceKey),
    sourceKey: source.sourceKey,
    source,
    rupiah,
    geon,
    identity,
    candidates,
    autoCandidate,
    reason,
  };
}

function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : { version: 1, records: {} };
  } catch (err) {
    if (err?.code !== 'ENOENT') console.error('Failed to read SociaBuzz topup store:', err);
    return { version: 1, records: {} };
  }
}

function saveStore(store) {
  const records = Object.values(store.records || {})
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, PAYMENT_STORE_LIMIT);
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: Object.fromEntries(records.map(record => [record.id, record])),
  };

  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function fieldValue(value) {
  return compact(value, 1000) || '-';
}

function candidatesText(candidates = []) {
  if (!candidates.length) return 'Tidak ada kandidat.';
  return candidates.map((candidate, index) => (
    `${index + 1}. \`${candidate.gamertag || '-'}\` | <@${candidate.userId}> | ${candidate.reason}`
  )).join('\n');
}

function identityText(identity = {}) {
  return [
    identity.gamertag ? `GT: \`${identity.gamertag}\`` : '',
    identity.discord ? `Discord: \`${identity.discord}\`` : '',
    identity.mention ? `Mention: <@${identity.mention}>` : '',
    identity.donor ? `Donor: \`${identity.donor}\`` : '',
  ].filter(Boolean).join('\n') || '-';
}

function buildPaymentEmbed(record, statusOverride = '') {
  const status = statusOverride || record.status || 'pending';
  const statusText = {
    queued: '✅ AUTO QUEUED',
    pending: '⏳ PENDING REVIEW',
    approved: '✅ APPROVED',
    rejected: '❌ REJECTED',
    ignored: '⚪ IGNORED',
  }[status] || status.toUpperCase();
  const color = status === 'queued' || status === 'approved'
    ? 0x2ecc71
    : (status === 'rejected' ? 0xe74c3c : 0xf2c94c);
  const source = record.source || {};
  const title = status === 'queued'
    ? 'SociaBuzz Auto Topup'
    : 'SociaBuzz Topup Review';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${statusText} • ${title}`)
    .setDescription([
      `Nominal: **${rupiahText(record.rupiah)}**`,
      `Geon otomatis: **${formatNumber(record.geon)} Geon**`,
      record.jobId ? `Job: \`${record.jobId}\`` : '',
      record.reason ? `Reason: \`${record.reason}\`` : '',
    ].filter(Boolean).join('\n'))
    .addFields(
      { name: 'Data terbaca', value: fieldValue(identityText(record.identity)), inline: false },
      { name: 'Kandidat', value: fieldValue(candidatesText(record.candidates)), inline: false },
      { name: 'Pesan', value: fieldValue(record.identity?.primaryText || record.identity?.fallbackText || '-'), inline: false }
    )
    .setFooter({
      text: [
        `ID ${record.id}`,
        source.messageId ? `Discord message ${source.messageId}` : '',
      ].filter(Boolean).join(' • '),
    })
    .setTimestamp(new Date(record.updatedAt || Date.now()));

  if (source.messageUrl) embed.setURL(source.messageUrl);
  return embed;
}

function buildReviewButtons(record) {
  const row = new ActionRowBuilder();
  const candidates = Array.isArray(record.candidates) ? record.candidates.slice(0, 4) : [];
  for (let index = 0; index < candidates.length; index += 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}:approve:${record.id}:${index}`)
        .setLabel(`Approve ${index + 1}`)
        .setStyle(ButtonStyle.Success)
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:reject:${record.id}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
  );
  return row.components.length ? [row] : [];
}

function isTopupAdmin(userId) {
  return String(userId || '') === String(TOPUP_ADMIN_DISCORD_ID);
}

function createSociabuzzTopupService({ bridge, registerStore, client }) {
  let store = loadStore();
  let logChannelPromise = null;

  function persist() {
    store = saveStore(store);
  }

  async function resolveLogChannel() {
    if (!client || !SOCIABUZZ_TOPUP_LOG_CHANNEL_ID) return null;
    if (!logChannelPromise) {
      logChannelPromise = client.channels.fetch(SOCIABUZZ_TOPUP_LOG_CHANNEL_ID).catch(err => {
        logChannelPromise = null;
        console.error('Failed to fetch SociaBuzz topup log channel:', err);
        return null;
      });
    }
    return logChannelPromise;
  }

  function sourceChannelAllowed(source) {
    if (!SOCIABUZZ_SOURCE_CHANNEL_IDS.size) return true;
    return SOCIABUZZ_SOURCE_CHANNEL_IDS.has(String(source.channelId || ''));
  }

  function upsertRecord(payment, patch = {}) {
    const now = new Date().toISOString();
    const current = store.records[payment.id] || {};
    const record = {
      ...current,
      id: payment.id,
      sourceKey: payment.sourceKey,
      source: payment.source,
      rupiah: payment.rupiah,
      geon: payment.geon,
      identity: payment.identity,
      candidates: payment.candidates,
      reason: payment.reason,
      createdAt: current.createdAt || now,
      updatedAt: now,
      ...patch,
    };
    store.records[record.id] = record;
    persist();
    return record;
  }

  async function sendLog(record, components = []) {
    const channel = await resolveLogChannel();
    if (!channel?.send) return null;
    return channel.send({
      embeds: [buildPaymentEmbed(record)],
      components,
      allowedMentions: { parse: [] },
    }).catch(err => {
      console.error('Failed to send SociaBuzz topup log:', err);
      return null;
    });
  }

  async function updateLogMessage(record, components = []) {
    const channel = await resolveLogChannel();
    if (!channel?.messages?.fetch || !record.logMessageId) return false;
    const message = await channel.messages.fetch(record.logMessageId).catch(() => null);
    if (!message?.edit) return false;
    await message.edit({
      embeds: [buildPaymentEmbed(record)],
      components,
      allowedMentions: { parse: [] },
    }).catch(() => null);
    return true;
  }

  function targetFromCandidate(candidate) {
    return {
      userId: candidate.userId,
      gamertag: candidate.gamertag,
      username: candidate.username,
      verified: candidate.verified,
    };
  }

  async function queueTopup(record, candidate, requestedBy, logMessage = null) {
    const job = bridge.enqueueTopup({
      target: targetFromCandidate(candidate),
      geon: record.geon,
      rupiah: record.rupiah,
      requestedBy,
      source: 'sociabuzz',
      paymentId: record.id,
      message: logMessage,
    });
    record.jobId = job.id;
    record.target = targetFromCandidate(candidate);
    record.status = record.status === 'pending' ? 'approved' : 'queued';
    record.updatedAt = new Date().toISOString();
    store.records[record.id] = record;
    persist();
    return job;
  }

  async function processPayment(payment, requestedBy = 'sociabuzz-auto') {
    const existing = store.records[payment.id];
    if (existing && !['ignored'].includes(existing.status)) {
      return { ok: true, code: 'already-seen', record: existing };
    }

    if (payment.autoCandidate) {
      let record = upsertRecord(payment, {
        status: 'queued',
        target: targetFromCandidate(payment.autoCandidate),
      });
      const logMessage = await sendLog(record, []);
      if (logMessage?.id) {
        record.logMessageId = logMessage.id;
        store.records[record.id] = record;
        persist();
      }
      const job = await queueTopup(record, payment.autoCandidate, requestedBy, logMessage);
      record.status = 'queued';
      record.jobId = job.id;
      store.records[record.id] = record;
      persist();
      await updateLogMessage(record, []);
      return { ok: true, code: 'queued', record, job };
    }

    let record = upsertRecord(payment, { status: 'pending' });
    const logMessage = await sendLog(record, buildReviewButtons(record));
    if (logMessage?.id) {
      record.logMessageId = logMessage.id;
      store.records[record.id] = record;
      persist();
    }
    return { ok: true, code: 'pending-review', record };
  }

  async function handleDiscordMessage(msg) {
    if (!msg || !msg.author?.bot) return false;
    if (client?.user?.id && msg.author.id === client.user.id) return false;
    const source = sourceFromDiscordMessage(msg);
    if (source.channelId === SOCIABUZZ_TOPUP_LOG_CHANNEL_ID) return false;
    if (!sourceChannelAllowed(source)) return false;
    const payment = parsePayment(source, registerStore);
    if (!payment) return false;

    await processPayment(payment, `discord:${msg.author.id}`);
    return true;
  }

  async function handleWebhookPayload(payload = {}) {
    const source = sourceFromWebhookPayload(payload);
    const payment = parsePayment(source, registerStore);
    if (!payment) return { ok: false, code: 'not-payment' };
    return processPayment(payment, 'sociabuzz-webhook');
  }

  async function handleInteraction(interaction) {
    if (!interaction?.isButton?.()) return false;
    const raw = String(interaction.customId || '');
    if (!raw.startsWith(`${BUTTON_PREFIX}:`)) return false;

    if (!isTopupAdmin(interaction.user?.id)) {
      await interaction.reply({
        content: 'Approval topup SociaBuzz hanya untuk admin topup.',
        ephemeral: true,
      }).catch(() => null);
      return true;
    }

    const [, action, recordId, indexRaw] = raw.split(':');
    const record = store.records[recordId];
    if (!record) {
      await interaction.reply({ content: 'Data payment tidak ditemukan atau sudah dibersihkan.', ephemeral: true }).catch(() => null);
      return true;
    }
    if (record.status !== 'pending') {
      await interaction.reply({ content: `Payment ini sudah berstatus ${record.status}.`, ephemeral: true }).catch(() => null);
      return true;
    }

    if (action === 'reject') {
      record.status = 'rejected';
      record.updatedAt = new Date().toISOString();
      record.rejectedBy = interaction.user.id;
      store.records[record.id] = record;
      persist();
      await interaction.update({
        embeds: [buildPaymentEmbed(record)],
        components: [],
        allowedMentions: { parse: [] },
      }).catch(() => null);
      return true;
    }

    if (action === 'approve') {
      const index = Math.floor(Number(indexRaw));
      const candidate = record.candidates?.[index];
      if (!candidate) {
        await interaction.reply({ content: 'Kandidat tidak valid.', ephemeral: true }).catch(() => null);
        return true;
      }
      const logMessage = interaction.message || null;
      await queueTopup(record, candidate, interaction.user.id, logMessage);
      await interaction.update({
        embeds: [buildPaymentEmbed(record)],
        components: [],
        allowedMentions: { parse: [] },
      }).catch(() => null);
      return true;
    }

    return false;
  }

  return {
    calculateGeon,
    handleDiscordMessage,
    handleWebhookPayload,
    handleInteraction,
    parsePayment: source => parsePayment(source, registerStore),
  };
}

module.exports = {
  RATE_TIERS,
  calculateGeon,
  createSociabuzzTopupService,
};
