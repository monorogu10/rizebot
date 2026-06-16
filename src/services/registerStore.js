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

function createRegisterStore() {
  const saveChannelStore = createEditableJsonMessageStore({
    channelId: SAVE_CHANNEL_ID,
    fileName: REGISTER_STORAGE_FILE_NAME
  });

  const state = { users: {}, order: [] };
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
      applyLoadedData(loaded);
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

  function applyLoadedData(loaded) {
    if (!loaded?.users) return false;
    const users = normalizeUsers(loaded.users);
    state.users = users;
    state.order = normalizeOrder(loaded.order, users);
    return true;
  }

  async function registerUser(userId, gamertag, username = '') {
    await ensureReady();
    if (state.users[userId]) {
      return { created: false, entry: state.users[userId] };
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
    return applyLoadedData(loaded);
  }

  function isStorageMessage(message) {
    return saveChannelStore.isDataMessage(message);
  }

  return {
    init,
    getUser,
    getEntries,
    getTotal,
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
