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
    normalized[userId] = {
      gamertag,
      username,
      registeredAt,
      updatedAt,
      answered,
      answeredAt
    };
  }
  return normalized;
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
  const lastCleanup = { removedDuplicateUserIds: [] };
  let lastLoadRemovedDuplicateCount = 0;
  let clientRef = null;
  let initPromise = null;

  function serialize() {
    return {
      users: state.users,
      order: state.order,
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
      answeredAt: null
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
    await persist();
    return state.users[userId];
  }

  async function markAnswered(userId) {
    await ensureReady();
    if (!state.users[userId]) return false;
    state.users[userId].answered = true;
    state.users[userId].answeredAt = new Date().toISOString();
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
    updateUser,
    markAnswered,
    removeUser,
    resetAll,
    reloadFromMessage,
    isStorageMessage
  };
}

module.exports = { createRegisterStore };
