const { createSaveChannelStore } = require('../storage/saveChannelStore');
const { SAVE_CHANNEL_ID, EVENT_REGISTRATION_STORAGE_FILE_NAME } = require('../config');

function normalizeEntry(userId, entry) {
  if (!userId || !entry) return null;
  const categoryCode = typeof entry.categoryCode === 'string' ? entry.categoryCode.trim() : '';
  const categoryName = typeof entry.categoryName === 'string' ? entry.categoryName.trim() : '';
  const mainCategory = typeof entry.mainCategory === 'string' ? entry.mainCategory.trim() : '';
  if (!categoryCode || !categoryName || !mainCategory) return null;

  const nowIso = new Date().toISOString();
  const username = typeof entry.username === 'string' ? entry.username : '';
  const subCategory = typeof entry.subCategory === 'string' && entry.subCategory.trim()
    ? entry.subCategory.trim()
    : null;
  const registeredAt = typeof entry.registeredAt === 'string' && entry.registeredAt
    ? entry.registeredAt
    : nowIso;
  const updatedAt = typeof entry.updatedAt === 'string' && entry.updatedAt
    ? entry.updatedAt
    : registeredAt;

  return {
    userId,
    username,
    categoryCode,
    categoryName,
    mainCategory,
    subCategory,
    registeredAt,
    updatedAt
  };
}

function normalizeRegistrations(registrations = {}) {
  const normalized = {};
  for (const [userId, entry] of Object.entries(registrations)) {
    const clean = normalizeEntry(userId, entry);
    if (!clean) continue;
    normalized[userId] = clean;
  }
  return normalized;
}

function createEventRegistrationStore() {
  const saveChannelStore = createSaveChannelStore({
    channelId: SAVE_CHANNEL_ID,
    fileName: EVENT_REGISTRATION_STORAGE_FILE_NAME
  });

  const state = { registrations: {} };
  let clientRef = null;
  let initPromise = null;

  function serialize() {
    return {
      registrations: state.registrations,
      updatedAt: new Date().toISOString()
    };
  }

  async function persist() {
    if (!clientRef) return;
    await saveChannelStore.save(clientRef, serialize());
  }

  async function init(client) {
    if (initPromise) return initPromise;
    clientRef = client;
    initPromise = (async () => {
      const loaded = await saveChannelStore.load(clientRef);
      if (!loaded?.registrations) return;
      state.registrations = normalizeRegistrations(loaded.registrations);
    })();
    return initPromise;
  }

  async function ensureReady() {
    if (initPromise) {
      await initPromise;
      return;
    }
    if (clientRef) return;
    throw new Error('Event registration store not initialized');
  }

  function getRegistration(userId) {
    return state.registrations[userId] || null;
  }

  function getRegistrations() {
    return Object.values(state.registrations).sort((a, b) => {
      return new Date(a.registeredAt).getTime() - new Date(b.registeredAt).getTime();
    });
  }

  async function upsertRegistration(data) {
    await ensureReady();
    if (!data?.userId) return null;

    const previous = state.registrations[data.userId] || null;
    const nowIso = new Date().toISOString();
    const entry = {
      userId: data.userId,
      username: data.username || previous?.username || '',
      categoryCode: data.categoryCode || previous?.categoryCode || '',
      categoryName: data.categoryName || previous?.categoryName || '',
      mainCategory: data.mainCategory || previous?.mainCategory || '',
      subCategory: data.subCategory || previous?.subCategory || null,
      registeredAt: previous?.registeredAt || nowIso,
      updatedAt: nowIso
    };

    const normalized = normalizeEntry(data.userId, entry);
    if (!normalized) return null;

    state.registrations[data.userId] = normalized;
    await persist();
    return {
      created: !previous,
      previous,
      entry: normalized
    };
  }

  async function removeRegistration(userId) {
    await ensureReady();
    if (!userId || !state.registrations[userId]) return false;
    delete state.registrations[userId];
    await persist();
    return true;
  }

  return {
    init,
    getRegistration,
    getRegistrations,
    upsertRegistration,
    removeRegistration
  };
}

module.exports = { createEventRegistrationStore };
