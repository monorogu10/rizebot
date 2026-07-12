const { createEditableJsonMessageStore } = require('../storage/editableJsonMessageStore');
const { SAVE_CHANNEL_ID, REGISTER_STORAGE_FILE_NAME } = require('../config');

function normalizeUsers(users = {}) {
  const normalized = {};
  for (const [userId, entry] of Object.entries(users)) {
    const gamertag = typeof entry?.gamertag === 'string' ? entry.gamertag.trim() : '';
    if (!gamertag) continue;
    const registeredAt = typeof entry?.registeredAt === 'string' && entry.registeredAt
      ? entry.registeredAt
      : new Date().toISOString();
    const answered = Boolean(entry?.answered);
    const answeredAt = typeof entry?.answeredAt === 'string' && entry.answeredAt
      ? entry.answeredAt
      : null;
    const updatedAt = typeof entry?.updatedAt === 'string' && entry.updatedAt
      ? entry.updatedAt
      : registeredAt;
    const username = typeof entry?.username === 'string' ? entry.username : '';
    const persistentId = typeof entry?.persistentId === 'string' ? entry.persistentId.trim() : '';
    const verified = Boolean(entry?.verified && persistentId);
    const verifiedAt = typeof entry?.verifiedAt === 'string' && entry.verifiedAt
      ? entry.verifiedAt
      : null;
    const lastSeenAt = typeof entry?.lastSeenAt === 'string' && entry.lastSeenAt
      ? entry.lastSeenAt
      : null;
    const lastSeenName = typeof entry?.lastSeenName === 'string' ? entry.lastSeenName.trim() : '';
    const nameHistory = Array.isArray(entry?.nameHistory)
      ? entry.nameHistory
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
        .slice(-10)
      : [];
    const status = normalizeStatus(entry?.status);
    const interviewId = typeof entry?.interviewId === 'string' ? entry.interviewId.trim() : '';
    const interviewChannelId = typeof entry?.interviewChannelId === 'string' ? entry.interviewChannelId.trim() : '';
    normalized[userId] = {
      gamertag,
      username,
      registeredAt,
      updatedAt,
      answered,
      answeredAt,
      persistentId,
      verified,
      verifiedAt,
      lastSeenAt,
      lastSeenName,
      nameHistory,
      status,
      legal: status === 'approved',
      interviewId,
      interviewChannelId,
      interviewCreatedAt: typeof entry?.interviewCreatedAt === 'string' ? entry.interviewCreatedAt : null,
      interviewClosedAt: typeof entry?.interviewClosedAt === 'string' ? entry.interviewClosedAt : null,
      approvedAt: typeof entry?.approvedAt === 'string' ? entry.approvedAt : null,
      approvedBy: typeof entry?.approvedBy === 'string' ? entry.approvedBy : '',
      approvedByName: typeof entry?.approvedByName === 'string' ? entry.approvedByName : '',
      rejectedAt: typeof entry?.rejectedAt === 'string' ? entry.rejectedAt : null,
      rejectedBy: typeof entry?.rejectedBy === 'string' ? entry.rejectedBy : '',
      rejectedByName: typeof entry?.rejectedByName === 'string' ? entry.rejectedByName : '',
      rejectionReason: typeof entry?.rejectionReason === 'string' ? entry.rejectionReason.trim().slice(0, 240) : ''
    };
  }
  return normalized;
}

function normalizeStatus(rawStatus) {
  const status = String(rawStatus || '').trim().toLowerCase();
  if (status === 'approved' || status === 'legal') return 'approved';
  if (status === 'rejected') return 'rejected';
  return 'pending';
}

function normalizeGamertagKey(gamertag) {
  return String(gamertag || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getRegisteredAtMs(entry) {
  const timestamp = new Date(entry?.registeredAt || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function normalizeOrder(order, users) {
  const seen = new Set();
  const result = [];
  if (Array.isArray(order)) {
    for (const userId of order) {
      if (typeof userId !== 'string') continue;
      if (!users[userId]) continue;
      if (seen.has(userId)) continue;
      seen.add(userId);
      result.push(userId);
    }
  }
  for (const userId of Object.keys(users)) {
    if (!seen.has(userId)) result.push(userId);
  }
  return result;
}

function removeDuplicateGamertags(users, order) {
  const keepByGamertag = new Map();
  const removedUserIds = [];

  for (const userId of order) {
    const entry = users[userId];
    if (!entry) continue;

    const key = normalizeGamertagKey(entry.gamertag);
    if (!key) continue;

    const current = keepByGamertag.get(key);
    if (!current) {
      keepByGamertag.set(key, userId);
      continue;
    }

    const currentEntry = users[current];
    const entryTime = getRegisteredAtMs(entry);
    const currentTime = getRegisteredAtMs(currentEntry);

    if (entryTime < currentTime) {
      removedUserIds.push(current);
      delete users[current];
      keepByGamertag.set(key, userId);
    } else {
      removedUserIds.push(userId);
      delete users[userId];
    }
  }

  return {
    users,
    order: order.filter(userId => users[userId]),
    removedUserIds
  };
}

function createRegisterStore() {
  const saveChannelStore = createEditableJsonMessageStore({
    channelId: SAVE_CHANNEL_ID,
    fileName: REGISTER_STORAGE_FILE_NAME
  });

  const state = { users: {}, order: [] };
  let interviewSequence = 0;
  const lastCleanup = { removedDuplicateUserIds: [] };
  let lastLoadRemovedDuplicateCount = 0;
  let clientRef = null;
  let initPromise = null;

  function serialize() {
    return {
      users: state.users,
      order: state.order,
      interviewSequence,
      updatedAt: new Date().toISOString()
    };
  }

  async function persist() {
    if (!clientRef) throw new Error('Register store not initialized');
    await saveChannelStore.save(clientRef, serialize());
  }

  async function init(client) {
    if (initPromise) return initPromise;
    clientRef = client;
    initPromise = (async () => {
      const loaded = await saveChannelStore.load(clientRef);
      const applied = applyLoadedData(loaded);
      if (applied && lastLoadRemovedDuplicateCount > 0) {
        await persist();
      }
    })();
    return initPromise;
  }

  async function ensureReady() {
    if (initPromise) {
      await initPromise;
      return;
    }
    if (clientRef) return;
    throw new Error('Register store not initialized');
  }

  function getUser(userId) {
    return state.users[userId];
  }

  function getEntries() {
    return state.order.map((userId, idx) => ({
      userId,
      gamertag: state.users[userId]?.gamertag || '',
      username: state.users[userId]?.username || '',
      registeredAt: state.users[userId]?.registeredAt || '',
      updatedAt: state.users[userId]?.updatedAt || '',
      answered: Boolean(state.users[userId]?.answered),
      answeredAt: state.users[userId]?.answeredAt || null,
      verified: Boolean(state.users[userId]?.verified),
      persistentId: state.users[userId]?.persistentId || '',
      verifiedAt: state.users[userId]?.verifiedAt || null,
      lastSeenAt: state.users[userId]?.lastSeenAt || null,
      lastSeenName: state.users[userId]?.lastSeenName || '',
      nameHistory: Array.isArray(state.users[userId]?.nameHistory)
        ? [...state.users[userId].nameHistory]
        : [],
      status: state.users[userId]?.status || 'pending',
      legal: state.users[userId]?.status === 'approved',
      interviewId: state.users[userId]?.interviewId || '',
      interviewChannelId: state.users[userId]?.interviewChannelId || '',
      interviewCreatedAt: state.users[userId]?.interviewCreatedAt || null,
      interviewClosedAt: state.users[userId]?.interviewClosedAt || null,
      approvedAt: state.users[userId]?.approvedAt || null,
      approvedBy: state.users[userId]?.approvedBy || '',
      approvedByName: state.users[userId]?.approvedByName || '',
      rejectedAt: state.users[userId]?.rejectedAt || null,
      rejectedBy: state.users[userId]?.rejectedBy || '',
      rejectedByName: state.users[userId]?.rejectedByName || '',
      rejectionReason: state.users[userId]?.rejectionReason || '',
      rank: idx + 1
    }));
  }

  function getTotal() {
    return state.order.length;
  }

  function findUserByGamertag(gamertag, exceptUserId = null) {
    const key = normalizeGamertagKey(gamertag);
    if (!key) return null;
    const exceptId = exceptUserId ? String(exceptUserId) : null;

    for (const userId of state.order) {
      if (exceptId && userId === exceptId) continue;
      const entry = state.users[userId];
      if (!entry) continue;
      if (normalizeGamertagKey(entry.gamertag) === key) {
        return {
          userId,
          entry
        };
      }
    }

    return null;
  }

  function getLastCleanup() {
    return {
      removedDuplicateUserIds: [...lastCleanup.removedDuplicateUserIds]
    };
  }

  function clearLastCleanup() {
    lastCleanup.removedDuplicateUserIds = [];
  }

  function applyLoadedData(loaded) {
    lastLoadRemovedDuplicateCount = 0;
    if (!loaded?.users) return false;
    const users = normalizeUsers(loaded.users);
    const order = normalizeOrder(loaded.order, users);
    const deduped = removeDuplicateGamertags(users, order);

    state.users = deduped.users;
    state.order = deduped.order;
    const loadedSequence = Math.max(0, Math.floor(Number(loaded.interviewSequence) || 0));
    const maxInterviewNumber = Object.values(state.users).reduce((max, entry) => {
      const match = String(entry?.interviewId || '').match(/(\d+)$/);
      const value = match ? Number(match[1]) : 0;
      return Number.isFinite(value) && value > max ? value : max;
    }, 0);
    interviewSequence = Math.max(loadedSequence, maxInterviewNumber);
    lastLoadRemovedDuplicateCount = deduped.removedUserIds.length;
    if (deduped.removedUserIds.length) {
      const pending = new Set(lastCleanup.removedDuplicateUserIds);
      for (const userId of deduped.removedUserIds) {
        pending.add(userId);
      }
      lastCleanup.removedDuplicateUserIds = [...pending];
    }
    return true;
  }

  async function registerUser(userId, gamertag, username = '') {
    await ensureReady();
    if (state.users[userId]) {
      return { created: false, entry: state.users[userId] };
    }
    const duplicate = findUserByGamertag(gamertag);
    if (duplicate) {
      return {
        created: false,
        duplicate: true,
        duplicateUserId: duplicate.userId,
        entry: duplicate.entry
      };
    }
    const nowIso = new Date().toISOString();
    const entry = {
      gamertag,
      username,
      registeredAt: nowIso,
      updatedAt: nowIso,
      answered: false,
      answeredAt: null,
      persistentId: '',
      verified: false,
      verifiedAt: null,
      lastSeenAt: null,
      lastSeenName: '',
      nameHistory: [],
      status: 'pending',
      legal: false,
      interviewId: '',
      interviewChannelId: '',
      interviewCreatedAt: null,
      interviewClosedAt: null,
      approvedAt: null,
      approvedBy: '',
      approvedByName: '',
      rejectedAt: null,
      rejectedBy: '',
      rejectedByName: '',
      rejectionReason: ''
    };
    state.users[userId] = entry;
    state.order.push(userId);
    await persist();
    return { created: true, entry };
  }

  async function nextInterviewId() {
    await ensureReady();
    interviewSequence += 1;
    await persist();
    return `interview-${String(interviewSequence).padStart(4, '0')}`;
  }

  async function upsertPendingUser(userId, gamertag, username = '', metadata = {}) {
    await ensureReady();
    const existing = state.users[userId];
    const nowIso = new Date().toISOString();
    if (existing) {
      existing.gamertag = gamertag;
      existing.username = username || existing.username || '';
      existing.updatedAt = nowIso;
      existing.answered = false;
      existing.answeredAt = null;
      existing.status = 'pending';
      existing.legal = false;
      existing.interviewId = metadata.interviewId || existing.interviewId || '';
      existing.interviewChannelId = metadata.interviewChannelId || existing.interviewChannelId || '';
      existing.interviewCreatedAt = metadata.interviewCreatedAt || existing.interviewCreatedAt || nowIso;
      existing.interviewClosedAt = null;
      existing.approvedAt = null;
      existing.approvedBy = '';
      existing.approvedByName = '';
      existing.rejectedAt = null;
      existing.rejectedBy = '';
      existing.rejectedByName = '';
      existing.rejectionReason = '';
      if (normalizeGamertagKey(gamertag) !== normalizeGamertagKey(existing.lastSeenName || '')) {
        existing.verified = false;
        existing.persistentId = '';
        existing.verifiedAt = null;
      }
      await persist();
      return { created: false, entry: existing };
    }

    const duplicate = findUserByGamertag(gamertag);
    if (duplicate) {
      return {
        created: false,
        duplicate: true,
        duplicateUserId: duplicate.userId,
        entry: duplicate.entry
      };
    }

    const entry = {
      gamertag,
      username,
      registeredAt: nowIso,
      updatedAt: nowIso,
      answered: false,
      answeredAt: null,
      persistentId: '',
      verified: false,
      verifiedAt: null,
      lastSeenAt: null,
      lastSeenName: '',
      nameHistory: [],
      status: 'pending',
      legal: false,
      interviewId: metadata.interviewId || '',
      interviewChannelId: metadata.interviewChannelId || '',
      interviewCreatedAt: metadata.interviewCreatedAt || nowIso,
      interviewClosedAt: null,
      approvedAt: null,
      approvedBy: '',
      approvedByName: '',
      rejectedAt: null,
      rejectedBy: '',
      rejectedByName: '',
      rejectionReason: ''
    };
    state.users[userId] = entry;
    state.order.push(userId);
    await persist();
    return { created: true, entry };
  }

  async function updateUser(userId, gamertag, username = '') {
    await ensureReady();
    if (!state.users[userId]) return null;
    const duplicate = findUserByGamertag(gamertag, userId);
    if (duplicate) {
      return {
        duplicate: true,
        duplicateUserId: duplicate.userId,
        entry: duplicate.entry
      };
    }
    state.users[userId].gamertag = gamertag;
    state.users[userId].username = username || state.users[userId].username || '';
    state.users[userId].updatedAt = new Date().toISOString();
    state.users[userId].status = 'pending';
    state.users[userId].legal = false;
    if (normalizeGamertagKey(gamertag) !== normalizeGamertagKey(state.users[userId].lastSeenName || '')) {
      state.users[userId].verified = false;
      state.users[userId].persistentId = '';
      state.users[userId].verifiedAt = null;
    }
    await persist();
    return state.users[userId];
  }

  async function updateApprovedGamertag(userId, gamertag, username = '') {
    await ensureReady();
    const entry = state.users[userId];
    if (!entry) return null;
    if (entry.status !== 'approved' && entry.legal !== true) {
      return { notApproved: true, entry };
    }

    const duplicate = findUserByGamertag(gamertag, userId);
    if (duplicate) {
      return {
        duplicate: true,
        duplicateUserId: duplicate.userId,
        entry: duplicate.entry
      };
    }

    const oldGamertag = entry.gamertag || '';
    const nowIso = new Date().toISOString();
    const history = Array.isArray(entry.nameHistory) ? entry.nameHistory : [];
    const nextHistory = [...history];
    for (const name of [oldGamertag, gamertag]) {
      if (!name) continue;
      if (!nextHistory.some(item => normalizeGamertagKey(item) === normalizeGamertagKey(name))) {
        nextHistory.push(name);
      }
    }

    entry.gamertag = gamertag;
    entry.username = username || entry.username || '';
    entry.updatedAt = nowIso;
    entry.status = 'approved';
    entry.legal = true;
    entry.nameHistory = nextHistory.slice(-10);
    if (normalizeGamertagKey(gamertag) !== normalizeGamertagKey(entry.lastSeenName || '')) {
      entry.verified = false;
      entry.persistentId = '';
      entry.verifiedAt = null;
    }
    await persist();
    return { updated: true, oldGamertag, entry };
  }

  async function markVerified(userId, payload = {}) {
    await ensureReady();
    const entry = state.users[userId];
    if (!entry) return null;

    const persistentId = String(payload.persistentId || '').trim();
    const gamertag = String(payload.gamertag || entry.gamertag || '').replace(/\s+/g, ' ').trim();
    if (!persistentId || !gamertag) return null;

    const nowIso = new Date().toISOString();
    const history = Array.isArray(entry.nameHistory) ? entry.nameHistory : [];
    const nextHistory = [...history];
    if (!nextHistory.some(name => normalizeGamertagKey(name) === normalizeGamertagKey(gamertag))) {
      nextHistory.push(gamertag);
    }

    entry.gamertag = gamertag;
    entry.persistentId = persistentId;
    entry.verified = true;
    entry.verifiedAt = entry.verifiedAt || nowIso;
    entry.updatedAt = nowIso;
    entry.lastSeenAt = nowIso;
    entry.lastSeenName = gamertag;
    entry.nameHistory = nextHistory.slice(-10);
    await persist();
    return entry;
  }

  async function approveUser(userId, reviewer = {}) {
    await ensureReady();
    const entry = state.users[userId];
    if (!entry) return null;
    const nowIso = new Date().toISOString();
    entry.status = 'approved';
    entry.legal = true;
    entry.approvedAt = nowIso;
    entry.approvedBy = String(reviewer.id || '').trim();
    entry.approvedByName = String(reviewer.name || reviewer.tag || '').trim();
    entry.rejectedAt = null;
    entry.rejectedBy = '';
    entry.rejectedByName = '';
    entry.rejectionReason = '';
    entry.updatedAt = nowIso;
    await persist();
    return entry;
  }

  async function rejectUser(userId, reviewer = {}, reasonRaw = '') {
    await ensureReady();
    const entry = state.users[userId];
    if (!entry) return null;
    const nowIso = new Date().toISOString();
    entry.status = 'rejected';
    entry.legal = false;
    entry.rejectedAt = nowIso;
    entry.rejectedBy = String(reviewer.id || '').trim();
    entry.rejectedByName = String(reviewer.name || reviewer.tag || '').trim();
    entry.rejectionReason = String(reasonRaw || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    entry.updatedAt = nowIso;
    await persist();
    return entry;
  }

  async function closeInterview(userId, reviewer = {}) {
    await ensureReady();
    const entry = state.users[userId];
    if (!entry) return null;
    entry.interviewClosedAt = new Date().toISOString();
    entry.updatedAt = entry.interviewClosedAt;
    entry.closedBy = String(reviewer.id || '').trim();
    entry.closedByName = String(reviewer.name || reviewer.tag || '').trim();
    await persist();
    return entry;
  }

  function findUserByInterviewChannel(channelIdRaw) {
    const channelId = String(channelIdRaw || '').trim();
    if (!channelId) return null;
    for (const userId of state.order) {
      const entry = state.users[userId];
      if (entry?.interviewChannelId === channelId) return { userId, entry };
    }
    return null;
  }

  async function markSeenByPersistentId(persistentIdRaw, gamertagRaw = '') {
    await ensureReady();
    const persistentId = String(persistentIdRaw || '').trim();
    if (!persistentId) return null;

    const gamertag = String(gamertagRaw || '').replace(/\s+/g, ' ').trim();
    const nowIso = new Date().toISOString();
    for (const userId of state.order) {
      const entry = state.users[userId];
      if (!entry || entry.persistentId !== persistentId) continue;

      const history = Array.isArray(entry.nameHistory) ? entry.nameHistory : [];
      const nextHistory = [...history];
      if (gamertag && !nextHistory.some(name => normalizeGamertagKey(name) === normalizeGamertagKey(gamertag))) {
        nextHistory.push(gamertag);
      }

      entry.lastSeenAt = nowIso;
      entry.lastSeenName = gamertag || entry.lastSeenName || entry.gamertag;
      entry.nameHistory = nextHistory.slice(-10);
      await persist();
      return { userId, entry };
    }

    return null;
  }

  async function markSeenByGamertag(gamertagRaw = '') {
    await ensureReady();
    const gamertag = String(gamertagRaw || '').replace(/\s+/g, ' ').trim();
    if (!gamertag) return null;

    const linked = findUserByGamertag(gamertag);
    if (!linked?.entry) return null;

    const nowIso = new Date().toISOString();
    const history = Array.isArray(linked.entry.nameHistory) ? linked.entry.nameHistory : [];
    const nextHistory = [...history];
    if (!nextHistory.some(name => normalizeGamertagKey(name) === normalizeGamertagKey(gamertag))) {
      nextHistory.push(gamertag);
    }

    linked.entry.lastSeenAt = nowIso;
    linked.entry.lastSeenName = gamertag;
    linked.entry.updatedAt = nowIso;
    linked.entry.nameHistory = nextHistory.slice(-10);
    await persist();
    return linked;
  }

  function findUserByPersistentId(persistentIdRaw) {
    const persistentId = String(persistentIdRaw || '').trim();
    if (!persistentId) return null;

    for (const userId of state.order) {
      const entry = state.users[userId];
      if (!entry) continue;
      if (entry.persistentId === persistentId) {
        return { userId, entry };
      }
    }

    return null;
  }

  async function markAnswered(userId) {
    await ensureReady();
    if (!state.users[userId]) return false;
    if (state.users[userId].status !== 'pending') return false;
    if (state.users[userId].answered) return true;
    const nowIso = new Date().toISOString();
    state.users[userId].answered = true;
    state.users[userId].answeredAt = nowIso;
    state.users[userId].updatedAt = nowIso;
    await persist();
    return true;
  }

  async function removeUser(userId) {
    await ensureReady();
    if (!state.users[userId]) return false;
    delete state.users[userId];
    state.order = state.order.filter(id => id !== userId);
    await persist();
    return true;
  }

  async function resetAll() {
    await ensureReady();
    state.users = {};
    state.order = [];
    await persist();
  }

  async function reloadFromMessage(message) {
    if (!saveChannelStore.isDataMessage(message)) return false;
    await ensureReady();
    const loaded = await saveChannelStore.loadFromMessage(message);
    const applied = applyLoadedData(loaded);
    if (applied && lastLoadRemovedDuplicateCount > 0) {
      await persist();
    }
    return applied;
  }

  function isStorageMessage(message) {
    return saveChannelStore.isDataMessage(message);
  }

  return {
    init,
    getUser,
    getEntries,
    getTotal,
    findUserByGamertag,
    getLastCleanup,
    clearLastCleanup,
    registerUser,
    nextInterviewId,
    upsertPendingUser,
    updateUser,
    updateApprovedGamertag,
    markVerified,
    approveUser,
    rejectUser,
    closeInterview,
    findUserByInterviewChannel,
    markSeenByPersistentId,
    markSeenByGamertag,
    findUserByPersistentId,
    markAnswered,
    removeUser,
    resetAll,
    reloadFromMessage,
    isStorageMessage
  };
}

module.exports = { createRegisterStore };
