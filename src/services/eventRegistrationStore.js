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

function normalizeSettings(raw) {
  const nowIso = new Date().toISOString();
  const settings = raw && typeof raw === 'object' ? raw : {};
  const categoryLocks = {};
  if (settings.categoryLocks && typeof settings.categoryLocks === 'object') {
    for (const [code, isLocked] of Object.entries(settings.categoryLocks)) {
      if (!code || !isLocked) continue;
      categoryLocks[String(code).trim()] = true;
    }
  }

  return {
    globalOpen: typeof settings.globalOpen === 'boolean' ? settings.globalOpen : true,
    categoryLocks,
    updatedAt: typeof settings.updatedAt === 'string' && settings.updatedAt ? settings.updatedAt : nowIso,
    updatedBy: typeof settings.updatedBy === 'string' && settings.updatedBy ? settings.updatedBy : null
  };
}

function normalizeAnnouncementHistory(rawList) {
  if (!Array.isArray(rawList)) return [];
  const result = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const categoryCode = typeof item.categoryCode === 'string' ? item.categoryCode.trim() : '';
    const categoryName = typeof item.categoryName === 'string' ? item.categoryName.trim() : '';
    if (!categoryCode || !categoryName) continue;

    result.push({
      categoryCode,
      categoryName,
      channelId: typeof item.channelId === 'string' ? item.channelId : null,
      messageId: typeof item.messageId === 'string' ? item.messageId : null,
      note: typeof item.note === 'string' && item.note.trim() ? item.note.trim() : null,
      announcedBy: typeof item.announcedBy === 'string' ? item.announcedBy : null,
      announcedAt: typeof item.announcedAt === 'string' && item.announcedAt
        ? item.announcedAt
        : new Date().toISOString()
    });
  }
  return result.slice(0, 50);
}

function cloneSettings(settings) {
  return {
    globalOpen: Boolean(settings?.globalOpen),
    categoryLocks: { ...(settings?.categoryLocks || {}) },
    updatedAt: settings?.updatedAt || null,
    updatedBy: settings?.updatedBy || null
  };
}

function normalizeCategoryCode(code) {
  if (!code) return '';
  return String(code).trim().toLowerCase();
}

function createEventRegistrationStore() {
  const saveChannelStore = createSaveChannelStore({
    channelId: SAVE_CHANNEL_ID,
    fileName: EVENT_REGISTRATION_STORAGE_FILE_NAME
  });

  const state = {
    registrations: {},
    settings: normalizeSettings(),
    announcementHistory: []
  };
  let clientRef = null;
  let initPromise = null;

  function serialize() {
    return {
      registrations: state.registrations,
      settings: state.settings,
      announcementHistory: state.announcementHistory,
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
      if (!loaded) return;
      state.registrations = normalizeRegistrations(loaded.registrations);
      state.settings = normalizeSettings(loaded.settings);
      state.announcementHistory = normalizeAnnouncementHistory(
        loaded.announcementHistory || loaded.announcements
      );
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

  function getRegistrationSettings() {
    return cloneSettings(state.settings);
  }

  function isRegistrationOpen(code) {
    const settings = state.settings;
    if (!settings.globalOpen) return false;
    const normalized = normalizeCategoryCode(code);
    if (!normalized) return true;

    if (settings.categoryLocks[normalized]) return false;
    const mainCode = normalized.split('.')[0];
    if (settings.categoryLocks[mainCode]) return false;
    return true;
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

  async function setGlobalRegistrationOpen(open, updatedBy = null) {
    await ensureReady();
    state.settings.globalOpen = Boolean(open);
    state.settings.updatedAt = new Date().toISOString();
    state.settings.updatedBy = updatedBy || null;
    await persist();
    return getRegistrationSettings();
  }

  async function setCategoryRegistrationOpen(code, open, updatedBy = null) {
    await ensureReady();
    const normalized = normalizeCategoryCode(code);
    if (!normalized) return getRegistrationSettings();

    if (open) {
      delete state.settings.categoryLocks[normalized];
    } else {
      state.settings.categoryLocks[normalized] = true;
    }
    state.settings.updatedAt = new Date().toISOString();
    state.settings.updatedBy = updatedBy || null;
    await persist();
    return getRegistrationSettings();
  }

  async function addAnnouncementLog(data) {
    await ensureReady();
    if (!data?.categoryCode || !data?.categoryName) return null;

    const entry = {
      categoryCode: String(data.categoryCode),
      categoryName: String(data.categoryName),
      channelId: data.channelId || null,
      messageId: data.messageId || null,
      note: data.note || null,
      announcedBy: data.announcedBy || null,
      announcedAt: data.announcedAt || new Date().toISOString()
    };

    state.announcementHistory.unshift(entry);
    if (state.announcementHistory.length > 50) {
      state.announcementHistory = state.announcementHistory.slice(0, 50);
    }
    await persist();
    return entry;
  }

  function getAnnouncementHistory(limit = 20) {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
    return state.announcementHistory.slice(0, safeLimit);
  }

  return {
    init,
    getRegistration,
    getRegistrations,
    upsertRegistration,
    removeRegistration,
    getRegistrationSettings,
    isRegistrationOpen,
    setGlobalRegistrationOpen,
    setCategoryRegistrationOpen,
    addAnnouncementLog,
    getAnnouncementHistory
  };
}

module.exports = { createEventRegistrationStore };
