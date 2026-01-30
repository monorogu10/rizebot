const { createSaveChannelStore } = require('../storage/saveChannelStore');
const { SAVE_CHANNEL_ID, MODERATION_STORAGE_FILE_NAME } = require('../config');

function normalizePetitions(petitions = {}) {
  const normalized = {};
  for (const [petitionId, entry] of Object.entries(petitions)) {
    if (!petitionId) continue;
    const guildId = typeof entry?.guildId === 'string' ? entry.guildId : null;
    const channelId = typeof entry?.channelId === 'string' ? entry.channelId : null;
    const messageId = typeof entry?.messageId === 'string' ? entry.messageId : petitionId;
    const targetId = typeof entry?.targetId === 'string' ? entry.targetId : null;
    const creatorId = typeof entry?.creatorId === 'string' ? entry.creatorId : null;
    const createdAt = typeof entry?.createdAt === 'string' && entry.createdAt
      ? entry.createdAt
      : new Date().toISOString();
    const expiresAt = typeof entry?.expiresAt === 'string' && entry.expiresAt
      ? entry.expiresAt
      : new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const status = typeof entry?.status === 'string' ? entry.status : 'active';
    const votes = Array.isArray(entry?.votes)
      ? Array.from(new Set(entry.votes.filter(id => typeof id === 'string' && id)))
      : [];
    const updatedAt = typeof entry?.updatedAt === 'string' && entry.updatedAt
      ? entry.updatedAt
      : createdAt;
    normalized[petitionId] = {
      petitionId,
      guildId,
      channelId,
      messageId,
      targetId,
      creatorId,
      createdAt,
      expiresAt,
      status,
      votes,
      updatedAt
    };
  }
  return normalized;
}

function createModerationStore() {
  const saveChannelStore = createSaveChannelStore({
    channelId: SAVE_CHANNEL_ID,
    fileName: MODERATION_STORAGE_FILE_NAME
  });

  const state = { petitions: {} };
  let clientRef = null;
  let initPromise = null;

  function serialize() {
    return {
      petitions: state.petitions,
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
      if (!loaded?.petitions) return;
      state.petitions = normalizePetitions(loaded.petitions);
    })();
    return initPromise;
  }

  async function ensureReady() {
    if (initPromise) {
      await initPromise;
      return;
    }
    if (clientRef) return;
    throw new Error('Moderation store not initialized');
  }

  function getPetition(petitionId) {
    return state.petitions[petitionId];
  }

  function getActivePetitions() {
    return Object.values(state.petitions).filter(petition => petition.status === 'active');
  }

  function getActivePetitionByTarget(guildId, targetId) {
    return Object.values(state.petitions).find(petition =>
      petition.status === 'active' &&
      petition.guildId === guildId &&
      petition.targetId === targetId
    );
  }

  async function createPetition(data) {
    await ensureReady();
    if (!data?.messageId) return null;
    const petitionId = data.messageId;
    const entry = {
      petitionId,
      guildId: data.guildId || null,
      channelId: data.channelId || null,
      messageId: data.messageId,
      targetId: data.targetId || null,
      creatorId: data.creatorId || null,
      createdAt: data.createdAt || new Date().toISOString(),
      expiresAt: data.expiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: 'active',
      votes: [],
      updatedAt: new Date().toISOString()
    };
    state.petitions[petitionId] = entry;
    await persist();
    return entry;
  }

  async function addVote(petitionId, userId) {
    await ensureReady();
    const petition = state.petitions[petitionId];
    if (!petition || petition.status !== 'active') return { added: false, petition };
    if (!userId) return { added: false, petition };
    if (petition.votes.includes(userId)) return { added: false, petition };
    petition.votes.push(userId);
    petition.updatedAt = new Date().toISOString();
    await persist();
    return { added: true, petition };
  }

  async function setStatus(petitionId, status, metadata = {}) {
    await ensureReady();
    const petition = state.petitions[petitionId];
    if (!petition) return null;
    petition.status = status;
    petition.updatedAt = new Date().toISOString();
    for (const [key, value] of Object.entries(metadata)) {
      petition[key] = value;
    }
    await persist();
    return petition;
  }

  return {
    init,
    getPetition,
    getActivePetitions,
    getActivePetitionByTarget,
    createPetition,
    addVote,
    setStatus
  };
}

module.exports = { createModerationStore };
