const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
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
const DEFAULT_GEON_PER_1000 = 100;
const RESOLUTION_TOKEN_TTL_MS = 15 * 60 * 1000;
const SOCIABUZZ_BACKFILL_LIMIT = Math.max(
  1,
  Math.min(1000, Math.floor(Number(process.env.SOCIABUZZ_BACKFILL_LIMIT) || 500))
);
const ACTIVE_PAYMENT_STATUSES = new Set(['needs_target', 'pending', 'resolving', 'failed']);
const UNKNOWN_NAMES = new Set([
  'someone',
  'anonymous',
  'anonim',
  'unknown',
  'tidak diketahui',
  'tanpa nama',
  'orang baik',
]);
const GAMERTAG_LABELS = [
  'NAMA PLAYER',
  'NAMA MINECRAFT',
  'NAMA MC',
  'GAMERTAG',
  'MINECRAFT',
  'PLAYER',
  'IGN',
  'GT',
  'MC',
  // Template monoCrowdfunding currently uses `Nama:` for the Minecraft name.
  'NAMA',
];
const DISCORD_LABELS = [
  'NAMA DISCORD',
  'NAMA DC',
  'DISCORD USER',
  'DISCORD ID',
  'DISCORD',
  'DC',
];
const IDENTITY_LABELS = [...GAMERTAG_LABELS, ...DISCORD_LABELS];

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

function calculateBaseGeon(rupiahRaw) {
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

function calculateGeon(rupiahRaw, geonPer1000Raw = DEFAULT_GEON_PER_1000) {
  const base = calculateBaseGeon(rupiahRaw);
  if (!base) return 0;
  const geonPer1000 = Math.max(1, Math.floor(Number(geonPer1000Raw) || DEFAULT_GEON_PER_1000));
  return Math.max(1, Math.floor((base * geonPer1000) / DEFAULT_GEON_PER_1000));
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
  const gamertag = extractLabel(primaryText, GAMERTAG_LABELS);
  const discord = normalizeDiscordHandle(
    extractLabel(primaryText, DISCORD_LABELS)
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

function lookupKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function damerauLevenshtein(leftRaw, rightRaw) {
  const left = lookupKey(leftRaw);
  const right = lookupKey(rightRaw);
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  const rows = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let row = 0; row <= left.length; row += 1) rows[row][0] = row;
  for (let column = 0; column <= right.length; column += 1) rows[0][column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + cost
      );
      if (row > 1 && column > 1 &&
          left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        rows[row][column] = Math.min(rows[row][column], rows[row - 2][column - 2] + cost);
      }
    }
  }
  return rows[left.length][right.length];
}

function fuzzyScore(queryRaw, candidateRaw) {
  const query = lookupKey(queryRaw);
  const candidate = lookupKey(candidateRaw);
  if (!query || !candidate) return 99;
  if (query === candidate) return 0;
  if (query.length >= 3 && candidate.startsWith(query)) return 0.35;
  if (query.length >= 4 && candidate.includes(query)) return 0.6;
  const distance = damerauLevenshtein(query, candidate);
  const longest = Math.max(query.length, candidate.length);
  const maximum = longest <= 4 ? 1 : (longest <= 8 ? 2 : 3);
  if (distance > maximum) return 99;
  return 1 + (distance / Math.max(1, longest));
}

function isEligibleTopupEntry(entry) {
  return Boolean(entry?.gamertag && (entry.status === 'approved' || entry.legal === true));
}

function discordNamesForUser(client, userId) {
  const names = [];
  const cachedUser = client?.users?.cache?.get?.(String(userId));
  for (const value of [cachedUser?.username, cachedUser?.globalName, cachedUser?.tag]) {
    if (value) names.push(String(value));
  }
  for (const guild of client?.guilds?.cache?.values?.() || []) {
    const member = guild?.members?.cache?.get?.(String(userId));
    for (const value of [member?.displayName, member?.nickname, member?.user?.username, member?.user?.globalName]) {
      if (value) names.push(String(value));
    }
  }
  return [...new Set(names.map(value => normalizeDiscordHandle(value)).filter(Boolean))];
}

function entrySearchNames(entry, client) {
  return [...new Set([
    entry.gamertag,
    entry.lastSeenName,
    ...(Array.isArray(entry.nameHistory) ? entry.nameHistory : []),
    entry.username,
    ...discordNamesForUser(client, entry.userId),
  ].map(value => compact(value, 120)).filter(Boolean))];
}

function candidateFromEntry(entry, reason, confidence, score = 0) {
  return {
    userId: String(entry.userId || ''),
    gamertag: compact(entry.gamertag || '', 80),
    username: compact(entry.username || '', 120),
    verified: Boolean(entry.verified),
    status: entry.status || (entry.legal ? 'approved' : 'pending'),
    reason,
    reasons: [reason],
    confidence,
    score,
  };
}

function confidenceRank(value) {
  return ({ exact: 3, learned: 2, fuzzy: 1 })[value] || 0;
}

function dedupeCandidates(candidates) {
  const byTarget = new Map();
  for (const candidate of candidates) {
    const key = candidate.userId || n(candidate.gamertag);
    if (!key) continue;
    const current = byTarget.get(key);
    if (!current) {
      byTarget.set(key, candidate);
      continue;
    }
    current.reasons = [...new Set([...(current.reasons || [current.reason]), ...(candidate.reasons || [candidate.reason])])];
    current.reason = current.reasons.join(', ');
    if (candidate.score < current.score) current.score = candidate.score;
    if (confidenceRank(candidate.confidence) > confidenceRank(current.confidence)) {
      current.confidence = candidate.confidence;
    }
  }
  return [...byTarget.values()]
    .sort((left, right) => left.score - right.score || confidenceRank(right.confidence) - confidenceRank(left.confidence) || left.gamertag.localeCompare(right.gamertag))
    .slice(0, MAX_CANDIDATES);
}

function findCandidates(registerStore, identity, { client = null, database = null } = {}) {
  const entries = registerStore.getEntries().filter(isEligibleTopupEntry);
  const candidates = [];
  const entryByUserId = new Map(entries.map(entry => [String(entry.userId), entry]));

  if (identity.mention) {
    const rawEntry = registerStore.getUser(identity.mention);
    const entry = rawEntry ? { ...rawEntry, userId: identity.mention } : null;
    if (isEligibleTopupEntry(entry)) candidates.push(candidateFromEntry(entry, 'Discord mention/ID exact', 'exact', 0));
  }

  if (identity.gamertag) {
    const linked = registerStore.findUserByGamertag?.(identity.gamertag);
    if (isEligibleTopupEntry(linked?.entry)) {
      candidates.push(candidateFromEntry({ ...linked.entry, userId: linked.userId }, 'GT exact', 'exact', 0));
    }
  }

  for (const descriptor of [
    { value: identity.gamertag, type: 'gamertag' },
    { value: identity.discord, type: 'discord' },
  ]) {
    if (!descriptor.value || !database?.findTopupRecipientAlias) continue;
    const alias = database.findTopupRecipientAlias(descriptor.value);
    const entry = alias ? entryByUserId.get(String(alias.userId)) : null;
    if (entry) candidates.push(candidateFromEntry(entry, `alias ${descriptor.type} terkonfirmasi`, 'learned', 0.05));
  }

  if (identity.discord) {
    for (const entry of entries) {
      const names = [entry.username, ...discordNamesForUser(client, entry.userId)];
      if (names.some(value => lookupKey(value) === lookupKey(identity.discord))) {
        candidates.push(candidateFromEntry(entry, 'Nama Discord exact', 'exact', 0));
      }
    }
  }

  const fuzzyQueries = [
    { value: identity.gamertag, label: 'GT', allowExact: true },
    { value: identity.discord, label: 'Discord', allowExact: true },
    // Donor may be paying for somebody else, so it can suggest but never auto-approve.
    { value: identity.donor, label: 'donor', allowExact: false },
  ].filter(item => item.value && !UNKNOWN_NAMES.has(n(item.value)));
  for (const descriptor of fuzzyQueries) {
    for (const entry of entries) {
      const score = Math.min(...entrySearchNames(entry, client).map(value => fuzzyScore(descriptor.value, value)));
      if (!Number.isFinite(score) || score >= 99) continue;
      const exact = score === 0 && descriptor.allowExact;
      candidates.push(candidateFromEntry(
        entry,
        `${descriptor.label} ${exact ? 'exact' : `mirip (${score.toFixed(2)})`}`,
        exact ? 'exact' : 'fuzzy',
        exact ? 0 : score + (descriptor.label === 'donor' ? 1 : 0)
      ));
    }
  }

  return dedupeCandidates(candidates);
}

function exactAutoCandidate(candidates) {
  const exact = candidates.filter(candidate => ['exact', 'learned'].includes(candidate.confidence));
  if (exact.length !== 1) return null;
  return exact[0];
}

function parsePayment(source, registerStore, context = {}) {
  if (!looksLikeSociabuzzPayment(source)) return null;
  const { allText } = textForParsing(source);
  const rupiah = extractRupiah(allText);
  if (!rupiah) return null;
  const rate = context.rate || { version: 0, geonPer1000: DEFAULT_GEON_PER_1000 };
  const geon = calculateGeon(rupiah, rate.geonPer1000);
  const identity = extractIdentity(source);
  const candidates = findCandidates(registerStore, identity, context);
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
    rate,
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
  const temporaryFile = `${STORE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(temporaryFile, STORE_FILE);
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
  const status = statusOverride || record.status || 'needs_target';
  const statusText = {
    queued: 'QUEUED TO MINECRAFT',
    needs_target: 'NEEDS TARGET',
    pending: 'NEEDS TARGET',
    resolving: 'WAITING CONFIRMATION',
    pending_join: 'PENDING PLAYER JOIN',
    delivered: 'DELIVERED',
    failed: 'DELIVERY FAILED',
    canceled: 'CANCELED',
    rejected: 'CANCELED',
    ignored: 'IGNORED',
  }[status] || status.toUpperCase();
  const color = status === 'queued' || status === 'delivered'
    ? 0x2ecc71
    : (status === 'failed' || status === 'canceled' || status === 'rejected' ? 0xe74c3c : 0xf2c94c);
  const source = record.source || {};
  const title = ['queued', 'delivered', 'pending_join'].includes(status)
    ? 'SociaBuzz Topup'
    : 'SociaBuzz Topup Resolution';
  const rate = record.rate?.geonPer1000 || DEFAULT_GEON_PER_1000;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${statusText} - ${title}`)
    .setDescription([
      `Nominal: **${rupiahText(record.rupiah)}**`,
      `Geon otomatis: **${formatNumber(record.geon)} Geon**`,
      `Rate transaksi: **${formatNumber(rate)} Geon / Rp1.000**`,
      record.target?.gamertag ? `Target: \`${record.target.gamertag}\` | <@${record.target.userId}>` : '',
      record.jobId ? `Job: \`${record.jobId}\`` : '',
      record.reason ? `Reason: \`${record.reason}\`` : '',
      record.failureCode ? `Hasil Minecraft: \`${record.failureCode}\`` : '',
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
      ].filter(Boolean).join(' | '),
    })
    .setTimestamp(new Date(record.updatedAt || Date.now()));

  if (source.messageUrl) embed.setURL(source.messageUrl);
  return embed;
}

function buildReviewComponents(record) {
  const components = [];
  const candidateRow = new ActionRowBuilder();
  const candidates = Array.isArray(record.candidates) ? record.candidates.slice(0, 4) : [];
  for (let index = 0; index < candidates.length; index += 1) {
    candidateRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}:approve:${record.id}:${index}`)
        .setLabel(`Kirim ke ${compact(candidates[index].gamertag, 55) || `kandidat ${index + 1}`}`)
        .setStyle(ButtonStyle.Success)
    );
  }
  if (candidateRow.components.length) components.push(candidateRow);

  components.push(new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`${BUTTON_PREFIX}:pickuser:${record.id}`)
      .setPlaceholder('Pilih member Discord tujuan')
      .setMinValues(1)
      .setMaxValues(1)
  ));

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:search:${record.id}`)
      .setLabel('Cari manual')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:rescan:${record.id}`)
      .setLabel('Scan ulang')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}:cancel:${record.id}`)
      .setLabel('Batalkan payment')
      .setStyle(ButtonStyle.Danger)
  ));
  return components;
}

function isTopupAdmin(userId) {
  return String(userId || '') === String(TOPUP_ADMIN_DISCORD_ID);
}

function createSociabuzzTopupService({ bridge, registerStore, client }) {
  let store = loadStore();
  let logChannelPromise = null;
  let databaseHydrated = false;
  const resolutionLocks = new Set();
  const processingPayments = new Map();
  const database = registerStore?.getDatabase?.() || null;
  let fallbackRate = {
    version: 0,
    geonPer1000: DEFAULT_GEON_PER_1000,
    changedBy: 'system',
    changedByName: 'Default',
    reason: 'Default Geon rate',
    createdAt: '',
  };

  function ensureDatabaseHydrated() {
    if (databaseHydrated) return;
    databaseHydrated = true;
    if (!database?.listSociabuzzPayments) return;
    database.init?.();
    const persisted = database.listSociabuzzPayments({ limit: PAYMENT_STORE_LIMIT });
    if (persisted.length) {
      store.records = Object.fromEntries(persisted.map(record => [record.id, record]));
      return;
    }
    for (const record of Object.values(store.records || {})) {
      if (record?.id && record?.sourceKey) database.saveSociabuzzPayment(record);
    }
  }

  function getRate() {
    ensureDatabaseHydrated();
    return database?.getGeonRate?.() || fallbackRate;
  }

  function setRate(geonPer1000, actor = {}, reason = '') {
    ensureDatabaseHydrated();
    if (database?.setGeonRate) return database.setGeonRate(geonPer1000, actor, reason);
    const safeValue = Math.floor(Number(geonPer1000) || 0);
    if (safeValue < 1 || safeValue > 1_000_000) {
      throw new Error('Geon rate harus antara 1 dan 1.000.000 per Rp1.000');
    }
    fallbackRate = {
      version: fallbackRate.version + 1,
      geonPer1000: safeValue,
      changedBy: String(actor.id || actor.userId || ''),
      changedByName: compact(actor.name || actor.username || actor.tag || 'Unknown Admin', 100),
      reason: compact(reason, 240),
      createdAt: new Date().toISOString(),
    };
    return fallbackRate;
  }

  function listRateHistory(limit = 10) {
    ensureDatabaseHydrated();
    return database?.listGeonRateHistory?.({ limit }) || [fallbackRate];
  }

  function paymentContext() {
    return { client, database, rate: getRate() };
  }

  function persist(record = null) {
    ensureDatabaseHydrated();
    if (record?.id && record?.sourceKey) database?.saveSociabuzzPayment?.(record);
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
      rate: payment.rate,
      identity: payment.identity,
      candidates: payment.candidates,
      reason: payment.reason,
      createdAt: current.createdAt || now,
      updatedAt: now,
      ...patch,
    };
    store.records[record.id] = record;
    persist(record);
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

  function currentCandidate(candidate) {
    const userId = String(candidate?.userId || '');
    const entry = userId ? registerStore.getUser(userId) : null;
    if (!isEligibleTopupEntry(entry)) return null;
    return candidateFromEntry(
      { ...entry, userId },
      candidate.reason || 'pilihan admin',
      candidate.confidence || 'exact',
      candidate.score || 0
    );
  }

  function manualCandidates(queryRaw) {
    const query = compact(queryRaw, 80);
    const mention = query.match(/^<@!?(\d{15,25})>$/)?.[1] || (/^\d{15,25}$/.test(query) ? query : '');
    return findCandidates(registerStore, {
      mention,
      gamertag: query,
      discord: query,
      donor: '',
    }, paymentContext());
  }

  function candidateForDiscordUser(userIdRaw) {
    const userId = String(userIdRaw || '');
    const entry = registerStore.getUser(userId);
    return isEligibleTopupEntry(entry)
      ? candidateFromEntry({ ...entry, userId }, 'member Discord dipilih admin', 'exact', 0)
      : null;
  }

  function actorFromUser(user = {}) {
    return {
      id: String(user.id || ''),
      name: compact(user.globalName || user.username || user.tag || 'Topup Admin', 100),
    };
  }

  function learnAliases(record, candidate, actor = {}, manualQuery = '') {
    if (!database?.saveTopupRecipientAlias || !candidate?.userId) return;
    const aliases = [
      { value: record.identity?.gamertag, type: 'sociabuzz-gamertag' },
      { value: record.identity?.discord, type: 'sociabuzz-discord' },
      { value: manualQuery, type: 'manual-resolution' },
    ];
    const seen = new Set();
    for (const alias of aliases) {
      const key = lookupKey(alias.value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      database.saveTopupRecipientAlias(alias.value, candidate.userId, actor, alias.type);
    }
  }

  async function queueTopup(record, candidate, requestedBy, logMessage = null) {
    const retry = record.status === 'failed';
    const job = bridge.enqueueTopup({
      target: targetFromCandidate(candidate),
      geon: record.geon,
      rupiah: record.rupiah,
      requestedBy,
      source: 'sociabuzz',
      paymentId: record.id,
      retry,
      message: logMessage,
    });
    record.jobId = job.id;
    record.target = targetFromCandidate(candidate);
    record.status = 'queued';
    record.failureCode = '';
    delete record.pendingResolution;
    record.updatedAt = new Date().toISOString();
    store.records[record.id] = record;
    persist(record);
    return job;
  }

  async function queueResolvedTopup(record, candidateRaw, actor = {}, logMessage = null, manualQuery = '') {
    const candidate = currentCandidate(candidateRaw);
    if (!candidate) return { ok: false, code: 'target-not-approved' };
    if (record.jobId && record.status !== 'failed') return { ok: false, code: 'already-queued' };
    learnAliases(record, candidate, actor, manualQuery);
    const job = await queueTopup(record, candidate, actor.id || 'sociabuzz-admin', logMessage);
    await updateLogMessage(record, []);
    return { ok: true, code: 'queued', record, job };
  }

  async function processPaymentUnlocked(payment, requestedBy = 'sociabuzz-auto') {
    const existing = store.records[payment.id];
    if (existing && !['ignored'].includes(existing.status)) {
      if (existing.status === 'preparing' && !existing.jobId) {
        // Recover a process that stopped between persisting the receipt and enqueueing the bridge job.
      } else if (!existing.logMessageId && existing.status !== 'canceled') {
        const components = ACTIVE_PAYMENT_STATUSES.has(existing.status) ? buildReviewComponents(existing) : [];
        const logMessage = await sendLog(existing, components);
        if (logMessage?.id) {
          existing.logMessageId = logMessage.id;
          existing.updatedAt = new Date().toISOString();
          store.records[existing.id] = existing;
          persist(existing);
        }
        return { ok: true, code: 'already-seen-log-restored', record: existing };
      } else {
        return { ok: true, code: 'already-seen', record: existing };
      }
    }

    if (payment.autoCandidate) {
      let record = upsertRecord(payment, {
        status: 'preparing',
        target: targetFromCandidate(payment.autoCandidate),
      });
      const job = await queueTopup(record, payment.autoCandidate, requestedBy, null);
      const logMessage = await sendLog(record, []);
      if (logMessage?.id) {
        record.logMessageId = logMessage.id;
        store.records[record.id] = record;
        persist(record);
      }
      await updateLogMessage(record, []);
      return { ok: true, code: 'queued', record, job };
    }

    let record = upsertRecord(payment, { status: 'needs_target' });
    const logMessage = await sendLog(record, buildReviewComponents(record));
    if (logMessage?.id) {
      record.logMessageId = logMessage.id;
      store.records[record.id] = record;
      persist(record);
    }
    return { ok: true, code: 'needs-target', record };
  }

  function processPayment(payment, requestedBy = 'sociabuzz-auto') {
    const active = processingPayments.get(payment.id);
    if (active) return active;
    const task = processPaymentUnlocked(payment, requestedBy).finally(() => {
      if (processingPayments.get(payment.id) === task) processingPayments.delete(payment.id);
    });
    processingPayments.set(payment.id, task);
    return task;
  }

  async function recoverPendingPayments() {
    ensureDatabaseHydrated();
    const candidates = Object.values(store.records || {}).filter(record => (
      (record.status === 'preparing' && !record.jobId) ||
      (!record.logMessageId && ['queued', 'needs_target', 'pending', 'resolving', 'failed'].includes(record.status))
    ));
    const summary = { checked: candidates.length, recovered: 0, refreshed: 0, failed: 0 };
    for (const record of candidates) {
      try {
        const context = paymentContext();
        const payment = parsePayment(record.source || {}, registerStore, {
          ...context,
          rate: record.rate || context.rate,
        });
        if (!payment) {
          summary.failed += 1;
          continue;
        }
        await processPayment(payment, 'sociabuzz-startup-recovery');
        summary.recovered += 1;
      } catch (error) {
        summary.failed += 1;
        console.error(`Failed to recover SociaBuzz payment ${record.id || '-'}:`, error);
      }
    }
    const refreshable = Object.values(store.records || {}).filter(record => (
      record.logMessageId && ['queued', 'pending_join', 'delivered', 'failed'].includes(record.status)
    ));
    for (const record of refreshable) {
      const components = record.status === 'failed' ? buildReviewComponents(record) : [];
      if (await updateLogMessage(record, components)) summary.refreshed += 1;
    }
    return summary;
  }

  async function backfillRecentDiscordPayments({ limit = SOCIABUZZ_BACKFILL_LIMIT } = {}) {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || SOCIABUZZ_BACKFILL_LIMIT)));
    const summary = { channels: 0, scanned: 0, matched: 0, failed: 0 };
    if (!client?.channels?.fetch) return summary;

    for (const channelId of SOCIABUZZ_SOURCE_CHANNEL_IDS) {
      const channel = await client.channels.fetch(channelId).catch(error => {
        summary.failed += 1;
        console.error(`Failed to fetch SociaBuzz source channel ${channelId}:`, error);
        return null;
      });
      if (!channel?.messages?.fetch) continue;
      summary.channels += 1;
      const messages = [];
      let before;
      while (messages.length < safeLimit) {
        const requestLimit = Math.min(100, safeLimit - messages.length);
        const batch = await channel.messages.fetch({ limit: requestLimit, ...(before ? { before } : {}) })
          .catch(error => {
            summary.failed += 1;
            console.error(`Failed to backfill SociaBuzz channel ${channelId}:`, error);
            return null;
          });
        if (!batch?.size) break;
        const page = [...batch.values()];
        messages.push(...page);
        before = String(page[page.length - 1]?.id || '');
        if (!before || page.length < requestLimit) break;
      }

      messages.sort((left, right) => (
        Number(left.createdTimestamp || 0) - Number(right.createdTimestamp || 0) ||
        String(left.id || '').localeCompare(String(right.id || ''))
      ));
      for (const message of messages) {
        summary.scanned += 1;
        try {
          if (await handleDiscordMessage(message)) summary.matched += 1;
        } catch (error) {
          summary.failed += 1;
          console.error(`Failed to backfill SociaBuzz message ${message?.id || '-'}:`, error);
        }
      }
    }
    return summary;
  }

  async function handleDiscordMessage(msg) {
    if (!msg || !msg.author?.bot) return false;
    if (client?.user?.id && msg.author.id === client.user.id) return false;
    const source = sourceFromDiscordMessage(msg);
    if (source.channelId === SOCIABUZZ_TOPUP_LOG_CHANNEL_ID) return false;
    if (!sourceChannelAllowed(source)) return false;
    const payment = parsePayment(source, registerStore, paymentContext());
    if (!payment) return false;

    await processPayment(payment, `discord:${msg.author.id}`);
    return true;
  }

  async function handleWebhookPayload(payload = {}) {
    const source = sourceFromWebhookPayload(payload);
    const payment = parsePayment(source, registerStore, paymentContext());
    if (!payment) return { ok: false, code: 'not-payment' };
    return processPayment(payment, 'sociabuzz-webhook');
  }

  async function stageResolution(interaction, record, candidateRaw, manualQuery = '') {
    const candidate = currentCandidate(candidateRaw);
    if (!candidate) {
      await interaction.reply({ content: 'Target itu belum berstatus LEGAL/approved di registry.', ephemeral: true }).catch(() => null);
      return true;
    }
    const token = crypto.randomBytes(5).toString('hex');
    record.status = 'resolving';
    record.pendingResolution = {
      token,
      candidate: targetFromCandidate(candidate),
      reason: candidate.reason,
      manualQuery: compact(manualQuery, 80),
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + RESOLUTION_TOKEN_TTL_MS,
    };
    record.updatedAt = new Date().toISOString();
    store.records[record.id] = record;
    persist(record);
    await updateLogMessage(record, buildReviewComponents(record));
    await interaction.reply({
      content: [
        `Konfirmasi payment \`${record.id}\`:`,
        `**${formatNumber(record.geon)} Geon** (${rupiahText(record.rupiah)}) ke \`${candidate.gamertag}\` / <@${candidate.userId}>.`,
        'Alias dari data pembayaran ini akan disimpan setelah dikonfirmasi.',
      ].join('\n'),
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${BUTTON_PREFIX}:confirm:${record.id}:${token}`)
          .setLabel('Konfirmasi kirim')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${BUTTON_PREFIX}:undraft:${record.id}:${token}`)
          .setLabel('Batal pilih target')
          .setStyle(ButtonStyle.Secondary)
      )],
      ephemeral: true,
      allowedMentions: { parse: [] },
    }).catch(() => null);
    return true;
  }

  async function handleBridgeResult({ job, result }) {
    if (job?.type !== 'topup' || job?.source !== 'sociabuzz' || !job?.paymentId) return;
    ensureDatabaseHydrated();
    const record = store.records[job.paymentId];
    if (!record || (record.jobId && record.jobId !== job.id)) return;
    if (result?.ok) {
      record.status = result.status === 'pending' ? 'pending_join' : 'delivered';
      record.failureCode = '';
    } else {
      record.status = 'failed';
      record.failureCode = compact(result?.code || 'unknown', 100);
    }
    record.result = {
      ok: Boolean(result?.ok),
      status: compact(result?.status || '', 40),
      code: compact(result?.code || '', 100),
      receivedAt: new Date().toISOString(),
    };
    record.updatedAt = new Date().toISOString();
    store.records[record.id] = record;
    persist(record);
    await updateLogMessage(record, record.status === 'failed' ? buildReviewComponents(record) : []);
  }

  async function handleInteraction(interaction) {
    const supported = interaction?.isButton?.() || interaction?.isModalSubmit?.() || interaction?.isUserSelectMenu?.();
    if (!supported) return false;
    const raw = String(interaction.customId || '');
    if (!raw.startsWith(`${BUTTON_PREFIX}:`)) return false;

    if (!isTopupAdmin(interaction.user?.id)) {
      await interaction.reply({
        content: 'Resolusi topup SociaBuzz hanya untuk admin topup.',
        ephemeral: true,
      }).catch(() => null);
      return true;
    }

    ensureDatabaseHydrated();
    const [, action, recordId, detailRaw] = raw.split(':');
    const record = store.records[recordId];
    if (!record) {
      await interaction.reply({ content: 'Data payment tidak ditemukan atau sudah dibersihkan.', ephemeral: true }).catch(() => null);
      return true;
    }
    if (!ACTIVE_PAYMENT_STATUSES.has(record.status) && action !== 'undraft') {
      await interaction.reply({ content: `Payment ini sudah berstatus ${record.status}.`, ephemeral: true }).catch(() => null);
      return true;
    }

    if (action === 'cancel' || action === 'reject') {
      record.status = 'canceled';
      record.updatedAt = new Date().toISOString();
      record.canceledBy = interaction.user.id;
      delete record.pendingResolution;
      store.records[record.id] = record;
      persist(record);
      await interaction.update({
        embeds: [buildPaymentEmbed(record)],
        components: [],
        allowedMentions: { parse: [] },
      }).catch(() => null);
      return true;
    }

    if (action === 'approve') {
      const index = Math.floor(Number(detailRaw));
      const candidate = record.candidates?.[index];
      if (!candidate) {
        await interaction.reply({ content: 'Kandidat tidak valid.', ephemeral: true }).catch(() => null);
        return true;
      }
      if (resolutionLocks.has(record.id)) {
        await interaction.reply({ content: 'Payment sedang diproses oleh aksi admin lain.', ephemeral: true }).catch(() => null);
        return true;
      }
      resolutionLocks.add(record.id);
      try {
        const result = await queueResolvedTopup(record, candidate, actorFromUser(interaction.user), interaction.message || null);
        if (!result.ok) {
          await interaction.reply({ content: `Tidak dapat mengirim: ${result.code}.`, ephemeral: true }).catch(() => null);
          return true;
        }
        await interaction.update({
          embeds: [buildPaymentEmbed(record)],
          components: [],
          allowedMentions: { parse: [] },
        }).catch(() => null);
      } finally {
        resolutionLocks.delete(record.id);
      }
      return true;
    }

    if (action === 'pickuser') {
      const candidate = candidateForDiscordUser(interaction.values?.[0]);
      return stageResolution(interaction, record, candidate);
    }

    if (action === 'search') {
      const modal = new ModalBuilder()
        .setCustomId(`${BUTTON_PREFIX}:resolve:${record.id}`)
        .setTitle('Cari target topup')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('target')
            .setLabel('Gamertag, Discord, mention, atau ID')
            .setStyle(TextInputStyle.Short)
            .setMinLength(2)
            .setMaxLength(80)
            .setRequired(true)
        ));
      await interaction.showModal(modal).catch(() => null);
      return true;
    }

    if (action === 'resolve') {
      const query = interaction.fields?.getTextInputValue?.('target') || '';
      const candidates = manualCandidates(query);
      const exact = candidates.filter(candidate => ['exact', 'learned'].includes(candidate.confidence));
      const candidate = exact.length === 1 ? exact[0] : (candidates.length === 1 ? candidates[0] : null);
      if (!candidate) {
        await interaction.reply({
          content: candidates.length
            ? `Target masih ambigu. Gunakan tombol kandidat pada kartu atau cari lebih spesifik.\n${candidatesText(candidates)}`
            : 'Target tidak ditemukan di registry LEGAL. Pastikan user sudah approved atau pilih member Discord pada kartu.',
          ephemeral: true,
          allowedMentions: { parse: [] },
        }).catch(() => null);
        return true;
      }
      return stageResolution(interaction, record, candidate, query);
    }

    if (action === 'rescan') {
      record.candidates = findCandidates(registerStore, record.identity || {}, paymentContext());
      record.reason = record.candidates.length ? 'rescanned-needs-review' : 'rescanned-no-candidate';
      record.status = 'needs_target';
      delete record.pendingResolution;
      record.updatedAt = new Date().toISOString();
      store.records[record.id] = record;
      persist(record);
      await interaction.update({
        embeds: [buildPaymentEmbed(record)],
        components: buildReviewComponents(record),
        allowedMentions: { parse: [] },
      }).catch(() => null);
      return true;
    }

    if (action === 'undraft') {
      const pending = record.pendingResolution;
      if (!pending || pending.token !== detailRaw) {
        await interaction.reply({ content: 'Konfirmasi target sudah kedaluwarsa.', ephemeral: true }).catch(() => null);
        return true;
      }
      record.status = 'needs_target';
      delete record.pendingResolution;
      record.updatedAt = new Date().toISOString();
      store.records[record.id] = record;
      persist(record);
      await updateLogMessage(record, buildReviewComponents(record));
      await interaction.update({ content: 'Pemilihan target dibatalkan. Payment tetap terbuka.', components: [] }).catch(() => null);
      return true;
    }

    if (action === 'confirm') {
      const pending = record.pendingResolution;
      if (!pending || pending.token !== detailRaw || Number(pending.expiresAt) < Date.now()) {
        await interaction.reply({ content: 'Konfirmasi target sudah kedaluwarsa. Pilih target lagi dari kartu.', ephemeral: true }).catch(() => null);
        return true;
      }
      if (resolutionLocks.has(record.id)) {
        await interaction.reply({ content: 'Payment sedang diproses oleh aksi admin lain.', ephemeral: true }).catch(() => null);
        return true;
      }
      resolutionLocks.add(record.id);
      try {
        const result = await queueResolvedTopup(
          record,
          pending.candidate,
          actorFromUser(interaction.user),
          null,
          pending.manualQuery
        );
        if (!result.ok) {
          await interaction.reply({ content: `Tidak dapat mengirim: ${result.code}.`, ephemeral: true }).catch(() => null);
          return true;
        }
        await interaction.update({
          content: `Topup diantrikan ke Minecraft untuk \`${record.target.gamertag}\`. Ref \`${record.jobId}\`.`,
          components: [],
          allowedMentions: { parse: [] },
        }).catch(() => null);
      } finally {
        resolutionLocks.delete(record.id);
      }
      return true;
    }

    return false;
  }

  async function resolvePayment(recordIdRaw, query, actor = {}, message = null) {
    ensureDatabaseHydrated();
    const recordId = String(recordIdRaw || '').trim();
    const record = store.records[recordId];
    if (!record) return { ok: false, code: 'payment-not-found', candidates: [] };
    if (!ACTIVE_PAYMENT_STATUSES.has(record.status) && !['canceled', 'rejected'].includes(record.status)) {
      return { ok: false, code: `payment-${record.status}`, candidates: [] };
    }
    const candidates = manualCandidates(query);
    const exact = candidates.filter(candidate => ['exact', 'learned'].includes(candidate.confidence));
    const candidate = exact.length === 1 ? exact[0] : (candidates.length === 1 ? candidates[0] : null);
    if (!candidate) return { ok: false, code: candidates.length ? 'target-ambiguous' : 'target-not-found', candidates };
    if (resolutionLocks.has(record.id)) return { ok: false, code: 'payment-busy', candidates };
    resolutionLocks.add(record.id);
    try {
      return await queueResolvedTopup(record, candidate, actor, message, query);
    } finally {
      resolutionLocks.delete(record.id);
    }
  }

  bridge.onJobResult?.(handleBridgeResult);

  return {
    calculateGeon,
    calculateForRupiah: rupiah => calculateGeon(rupiah, getRate().geonPer1000),
    getRate,
    setRate,
    listRateHistory,
    resolvePayment,
    recoverPendingPayments,
    backfillRecentDiscordPayments,
    handleDiscordMessage,
    handleWebhookPayload,
    handleInteraction,
    parsePayment: source => parsePayment(source, registerStore, paymentContext()),
  };
}

module.exports = {
  RATE_TIERS,
  DEFAULT_GEON_PER_1000,
  damerauLevenshtein,
  calculateGeon,
  parsePayment,
  createSociabuzzTopupService,
};
