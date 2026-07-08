const { createEditableJsonMessageStore } = require('../storage/editableJsonMessageStore');
const {
  SAVE_CHANNEL_ID,
  INTERVIEW_TRANSCRIPT_FILE_PREFIX,
  INTERVIEW_TRANSCRIPT_INDEX_FILE_NAME,
} = require('../config');

const DEFAULT_MAX_SHARD_BYTES = 7 * 1024 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
}

function normalizeShardIndex(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function transcriptFileName(prefix, index) {
  return `${prefix}-${String(index).padStart(3, '0')}.json`;
}

function normalizeTranscript(transcript = {}) {
  const compiledAt = typeof transcript.compiledAt === 'string' && transcript.compiledAt
    ? transcript.compiledAt
    : nowIso();
  const channelId = String(transcript.channelId || transcript.channel?.id || '').trim();
  const guildId = String(transcript.guildId || transcript.guild?.id || '').trim();
  const fallbackId = [guildId, channelId].filter(Boolean).join(':') || `transcript:${compiledAt}`;
  const transcriptId = String(transcript.transcriptId || fallbackId).trim();

  return {
    ...transcript,
    transcriptId,
    channelId,
    guildId,
    compiledAt,
  };
}

function normalizeIndex(raw = {}) {
  const shards = Array.isArray(raw?.shards)
    ? raw.shards
      .map(item => ({
        index: normalizeShardIndex(item?.index),
        fileName: typeof item?.fileName === 'string' && item.fileName
          ? item.fileName
          : transcriptFileName(INTERVIEW_TRANSCRIPT_FILE_PREFIX, item?.index || 1),
        count: Math.max(0, Number(item?.count) || 0),
        bytes: Math.max(0, Number(item?.bytes) || 0),
        messageId: typeof item?.messageId === 'string' ? item.messageId : '',
        firstTranscriptId: typeof item?.firstTranscriptId === 'string' ? item.firstTranscriptId : '',
        lastTranscriptId: typeof item?.lastTranscriptId === 'string' ? item.lastTranscriptId : '',
        createdAt: typeof item?.createdAt === 'string' ? item.createdAt : nowIso(),
        updatedAt: typeof item?.updatedAt === 'string' ? item.updatedAt : nowIso(),
      }))
      .sort((a, b) => a.index - b.index)
    : [];

  const channels = raw?.channels && typeof raw.channels === 'object' && !Array.isArray(raw.channels)
    ? Object.fromEntries(Object.entries(raw.channels).map(([channelId, meta]) => [
      channelId,
      {
        transcriptId: typeof meta?.transcriptId === 'string' ? meta.transcriptId : '',
        shard: normalizeShardIndex(meta?.shard),
        fileName: typeof meta?.fileName === 'string' ? meta.fileName : '',
        compiledAt: typeof meta?.compiledAt === 'string' ? meta.compiledAt : '',
        deletedAt: typeof meta?.deletedAt === 'string' ? meta.deletedAt : '',
      },
    ]))
    : {};

  return {
    version: 1,
    shards,
    channels,
    transcriptCount: Math.max(0, Number(raw?.transcriptCount) || Object.keys(channels).length),
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  };
}

function normalizeShard(raw = {}, index, fileName) {
  const transcripts = Array.isArray(raw?.transcripts)
    ? raw.transcripts.filter(item => item && typeof item === 'object')
    : [];
  return {
    version: 1,
    shard: normalizeShardIndex(raw?.shard || index),
    fileName: typeof raw?.fileName === 'string' && raw.fileName ? raw.fileName : fileName,
    transcripts,
    count: transcripts.length,
    createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  };
}

function createInterviewTranscriptStore({
  channelId = SAVE_CHANNEL_ID,
  indexFileName = INTERVIEW_TRANSCRIPT_INDEX_FILE_NAME,
  filePrefix = INTERVIEW_TRANSCRIPT_FILE_PREFIX,
  maxShardBytes = Number(process.env.INTERVIEW_TRANSCRIPT_SHARD_BYTES) || DEFAULT_MAX_SHARD_BYTES,
} = {}) {
  const safeMaxShardBytes = Math.max(512 * 1024, Math.min(9 * 1024 * 1024, maxShardBytes));
  const indexStore = createEditableJsonMessageStore({ channelId, fileName: indexFileName });
  const shardStores = new Map();
  const shardData = new Map();
  let state = normalizeIndex();
  let clientRef = null;
  let initPromise = null;
  let saveQueue = Promise.resolve();

  function getShardStore(index) {
    const shardIndex = normalizeShardIndex(index);
    if (!shardStores.has(shardIndex)) {
      shardStores.set(shardIndex, createEditableJsonMessageStore({
        channelId,
        fileName: transcriptFileName(filePrefix, shardIndex),
      }));
    }
    return shardStores.get(shardIndex);
  }

  function getShardMeta(index) {
    return state.shards.find(item => item.index === normalizeShardIndex(index)) || null;
  }

  function createShardMeta(index) {
    const shardIndex = normalizeShardIndex(index);
    const createdAt = nowIso();
    const meta = {
      index: shardIndex,
      fileName: transcriptFileName(filePrefix, shardIndex),
      count: 0,
      bytes: 0,
      messageId: '',
      firstTranscriptId: '',
      lastTranscriptId: '',
      createdAt,
      updatedAt: createdAt,
    };
    state.shards.push(meta);
    state.shards.sort((a, b) => a.index - b.index);
    return meta;
  }

  function latestShardMeta() {
    if (!state.shards.length) return null;
    return [...state.shards].sort((a, b) => b.index - a.index)[0];
  }

  async function saveIndex() {
    state.transcriptCount = Object.keys(state.channels).length;
    state.updatedAt = nowIso();
    return indexStore.save(clientRef, state);
  }

  async function loadShard(index) {
    const shardIndex = normalizeShardIndex(index);
    if (shardData.has(shardIndex)) return shardData.get(shardIndex);

    const fileName = transcriptFileName(filePrefix, shardIndex);
    const store = getShardStore(shardIndex);
    const loaded = await store.load(clientRef);
    const normalized = normalizeShard(loaded || {}, shardIndex, fileName);
    shardData.set(shardIndex, normalized);
    return normalized;
  }

  async function saveShard(index, data) {
    const shardIndex = normalizeShardIndex(index);
    data.count = data.transcripts.length;
    data.updatedAt = nowIso();
    const store = getShardStore(shardIndex);
    return store.save(clientRef, data);
  }

  async function init(client) {
    if (initPromise) return initPromise;
    clientRef = client;
    initPromise = (async () => {
      const loaded = await indexStore.load(clientRef);
      state = normalizeIndex(loaded || {});
    })();
    return initPromise;
  }

  async function ensureReady() {
    if (initPromise) {
      await initPromise;
      return;
    }
    if (clientRef) return;
    throw new Error('Interview transcript store not initialized');
  }

  async function appendTranscriptNow(rawTranscript) {
    await ensureReady();
    const transcript = normalizeTranscript(rawTranscript);
    if (transcript.channelId && state.channels[transcript.channelId]) {
      return {
        ok: true,
        duplicate: true,
        transcriptId: state.channels[transcript.channelId].transcriptId,
        shard: state.channels[transcript.channelId].shard,
        fileName: state.channels[transcript.channelId].fileName,
      };
    }

    let meta = latestShardMeta() || createShardMeta(1);
    let data = await loadShard(meta.index);
    const preview = {
      ...data,
      transcripts: [...data.transcripts, transcript],
    };

    if (data.transcripts.length && byteLength(preview) > safeMaxShardBytes) {
      meta = createShardMeta(meta.index + 1);
      data = normalizeShard({}, meta.index, meta.fileName);
      shardData.set(meta.index, data);
    }

    data.transcripts.push(transcript);
    const message = await saveShard(meta.index, data);
    meta.count = data.transcripts.length;
    meta.bytes = byteLength(data);
    meta.messageId = message?.id || meta.messageId || '';
    meta.firstTranscriptId = data.transcripts[0]?.transcriptId || meta.firstTranscriptId || '';
    meta.lastTranscriptId = transcript.transcriptId;
    meta.updatedAt = data.updatedAt;
    if (!meta.createdAt) meta.createdAt = data.createdAt;

    if (transcript.channelId) {
      state.channels[transcript.channelId] = {
        transcriptId: transcript.transcriptId,
        shard: meta.index,
        fileName: meta.fileName,
        compiledAt: transcript.compiledAt,
        deletedAt: '',
      };
    }

    await saveIndex();
    return {
      ok: true,
      duplicate: false,
      transcriptId: transcript.transcriptId,
      shard: meta.index,
      fileName: meta.fileName,
      bytes: meta.bytes,
      count: meta.count,
    };
  }

  function appendTranscript(transcript) {
    saveQueue = saveQueue
      .catch(() => null)
      .then(() => appendTranscriptNow(transcript));
    return saveQueue;
  }

  async function markChannelDeleted(channelIdRaw) {
    await ensureReady();
    const channelId = String(channelIdRaw || '').trim();
    if (!channelId || !state.channels[channelId]) return false;
    state.channels[channelId].deletedAt = nowIso();
    await saveIndex();
    return true;
  }

  function shardIndexFromMessage(message) {
    const names = [
      ...[...message?.attachments?.values?.() || []].map(att => att.name),
      String(message?.content || ''),
    ].filter(Boolean);

    for (const value of names) {
      const match = String(value).match(new RegExp(`${filePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{3,})\\.json`));
      if (match) return normalizeShardIndex(match[1]);
    }
    return null;
  }

  async function reloadFromMessage(message) {
    await ensureReady();
    if (indexStore.isDataMessage(message)) {
      const loaded = await indexStore.loadFromMessage(message);
      state = normalizeIndex(loaded || {});
      return true;
    }

    const shardIndex = shardIndexFromMessage(message);
    if (!shardIndex) return false;
    const store = getShardStore(shardIndex);
    if (!store.isDataMessage(message)) return false;
    const loaded = await store.loadFromMessage(message);
    shardData.set(
      shardIndex,
      normalizeShard(loaded || {}, shardIndex, transcriptFileName(filePrefix, shardIndex))
    );
    return true;
  }

  function isStorageMessage(message) {
    return indexStore.isDataMessage(message) || Boolean(shardIndexFromMessage(message));
  }

  function getIndex() {
    return JSON.parse(JSON.stringify(state));
  }

  return {
    init,
    appendTranscript,
    markChannelDeleted,
    reloadFromMessage,
    isStorageMessage,
    getIndex,
  };
}

module.exports = { createInterviewTranscriptStore };
