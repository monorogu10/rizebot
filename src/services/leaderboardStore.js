const { createSaveChannelStore } = require('../storage/saveChannelStore');
const { SAVE_CHANNEL_ID, STORAGE_FILE_NAME } = require('../config');

function createLeaderboardStore() {
  const saveChannelStore = createSaveChannelStore({
    channelId: SAVE_CHANNEL_ID,
    fileName: STORAGE_FILE_NAME
  });

  const state = { users: {} };
  let clientRef = null;
  let initPromise = null;

  function normalizeUsers(users = {}) {
    const normalized = {};
    for (const [id, entry] of Object.entries(users)) {
      const models = Math.max(0, Number(entry?.models) || 0);
      const reward = Math.max(0, Number(entry?.reward) || 0);
      if (models > 0 || reward > 0) normalized[id] = { models, reward };
    }
    return normalized;
  }

  function serialize() {
    return {
      users: state.users,
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
      if (loaded?.users) state.users = normalizeUsers(loaded.users);
    })();
    return initPromise;
  }

  async function ensureReady() {
    if (initPromise) {
      await initPromise;
      return;
    }
    if (clientRef) return;
    throw new Error('Leaderboard store not initialized');
  }

  async function updateUser(userId, { modelsDelta = 0, rewardDelta = 0 }) {
    await ensureReady();
    const current = state.users[userId] || { models: 0, reward: 0 };
    const next = {
      models: Math.max(0, current.models + modelsDelta),
      reward: Math.max(0, current.reward + rewardDelta)
    };

    if (next.models === 0 && next.reward === 0) {
      delete state.users[userId];
    } else {
      state.users[userId] = next;
    }

    await persist();
    return state.users[userId] || { models: 0, reward: 0 };
  }

  async function resetAll() {
    await ensureReady();
    state.users = {};
    await persist();
  }

  function getUser(userId) {
    return state.users[userId];
  }

  function getLeaderboard() {
    return Object.entries(state.users)
      .map(([userId, entry]) => ({ userId, ...entry }))
      .sort((a, b) => {
        if (b.models !== a.models) return b.models - a.models;
        return b.reward - a.reward;
      });
  }

  return {
    init,
    updateUser,
    resetAll,
    getUser,
    getLeaderboard
  };
}

module.exports = { createLeaderboardStore };
