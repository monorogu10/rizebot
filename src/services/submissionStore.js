const { createSaveChannelStore } = require('../storage/saveChannelStore');
const { SAVE_CHANNEL_ID, SUBMISSION_STORAGE_FILE_NAME } = require('../config');

function normalizeMembers(members = {}) {
  const normalized = {};
  for (const [userId, entry] of Object.entries(members)) {
    if (!userId) continue;
    const grantedAt = typeof entry?.grantedAt === 'string' && entry.grantedAt
      ? entry.grantedAt
      : new Date().toISOString();
    const source = typeof entry?.source === 'string' && entry.source
      ? entry.source
      : 'unknown';
    normalized[userId] = { grantedAt, source };
  }
  return normalized;
}

function normalizeSubmissions(submissions = {}) {
  const normalized = {};
  for (const [messageId, entry] of Object.entries(submissions)) {
    if (!messageId) continue;
    const authorId = typeof entry?.authorId === 'string' ? entry.authorId : null;
    const channelId = typeof entry?.channelId === 'string' ? entry.channelId : null;
    const createdAt = typeof entry?.createdAt === 'string' && entry.createdAt
      ? entry.createdAt
      : new Date().toISOString();
    const approvals = Number.isFinite(entry?.approvals) ? entry.approvals : 0;
    const approvedAt = typeof entry?.approvedAt === 'string' && entry.approvedAt
      ? entry.approvedAt
      : null;
    normalized[messageId] = {
      messageId,
      authorId,
      channelId,
      createdAt,
      approvals,
      approvedAt
    };
  }
  return normalized;
}

function createSubmissionStore() {
  const saveChannelStore = createSaveChannelStore({
    channelId: SAVE_CHANNEL_ID,
    fileName: SUBMISSION_STORAGE_FILE_NAME
  });

  const state = { submissions: {}, approvedMembers: {}, permanentMembers: {} };
  let clientRef = null;
  let initPromise = null;

  function serialize() {
    return {
      submissions: state.submissions,
      approvedMembers: state.approvedMembers,
      permanentMembers: state.permanentMembers,
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
      state.submissions = normalizeSubmissions(loaded.submissions);
      state.approvedMembers = normalizeMembers(loaded.approvedMembers);
      state.permanentMembers = normalizeMembers(loaded.permanentMembers);
    })();
    return initPromise;
  }

  async function ensureReady() {
    if (initPromise) {
      await initPromise;
      return;
    }
    if (clientRef) return;
    throw new Error('Submission store not initialized');
  }

  function getSubmission(messageId) {
    return state.submissions[messageId];
  }

  function getSubmissions() {
    return Object.values(state.submissions);
  }

  function getApprovedMemberIds() {
    return Object.keys(state.approvedMembers);
  }

  function getPermanentMemberIds() {
    return Object.keys(state.permanentMembers);
  }

  function isApprovedMember(userId) {
    return Boolean(state.approvedMembers[userId]);
  }

  function isPermanentMember(userId) {
    return Boolean(state.permanentMembers[userId]);
  }

  async function upsertSubmission(data) {
    await ensureReady();
    if (!data?.messageId) return null;
    const existing = state.submissions[data.messageId];
    const entry = {
      messageId: data.messageId,
      authorId: data.authorId || existing?.authorId || null,
      channelId: data.channelId || existing?.channelId || null,
      createdAt: data.createdAt || existing?.createdAt || new Date().toISOString(),
      approvals: Number.isFinite(data.approvals)
        ? data.approvals
        : (existing?.approvals || 0),
      approvedAt: data.approvedAt || existing?.approvedAt || null
    };
    state.submissions[data.messageId] = entry;
    await persist();
    return entry;
  }

  async function updateSubmissionApprovals(messageId, approvals) {
    await ensureReady();
    if (!messageId || !Number.isFinite(approvals)) return null;
    const existing = state.submissions[messageId] || {
      messageId,
      authorId: null,
      channelId: null,
      createdAt: new Date().toISOString(),
      approvals: 0,
      approvedAt: null
    };
    if (existing.approvals === approvals) return existing;
    existing.approvals = approvals;
    state.submissions[messageId] = existing;
    await persist();
    return existing;
  }

  async function markSubmissionApproved(messageId, approvedAt = new Date().toISOString()) {
    await ensureReady();
    if (!messageId) return null;
    const existing = state.submissions[messageId] || {
      messageId,
      authorId: null,
      channelId: null,
      createdAt: new Date().toISOString(),
      approvals: 0,
      approvedAt: null
    };
    if (existing.approvedAt) return existing;
    existing.approvedAt = approvedAt;
    state.submissions[messageId] = existing;
    await persist();
    return existing;
  }

  async function addApprovedMembers(userIds, source = 'vote') {
    await ensureReady();
    if (!Array.isArray(userIds) || !userIds.length) return false;
    let changed = false;
    for (const userId of userIds) {
      if (!userId) continue;
      if (!state.approvedMembers[userId]) {
        state.approvedMembers[userId] = {
          grantedAt: new Date().toISOString(),
          source
        };
        changed = true;
      }
    }
    if (changed) await persist();
    return changed;
  }

  async function addPermanentMembers(userIds, source = 'legacy') {
    await ensureReady();
    if (!Array.isArray(userIds) || !userIds.length) return false;
    let changed = false;
    for (const userId of userIds) {
      if (!userId) continue;
      if (!state.permanentMembers[userId]) {
        state.permanentMembers[userId] = {
          grantedAt: new Date().toISOString(),
          source
        };
        changed = true;
      }
      if (!state.approvedMembers[userId]) {
        state.approvedMembers[userId] = {
          grantedAt: new Date().toISOString(),
          source
        };
        changed = true;
      }
    }
    if (changed) await persist();
    return changed;
  }

  async function markApprovedMember(userId, source = 'vote') {
    return addApprovedMembers([userId], source);
  }

  async function markPermanentMember(userId, source = 'legacy') {
    return addPermanentMembers([userId], source);
  }

  return {
    init,
    getSubmission,
    getSubmissions,
    getApprovedMemberIds,
    getPermanentMemberIds,
    isApprovedMember,
    isPermanentMember,
    upsertSubmission,
    updateSubmissionApprovals,
    markSubmissionApproved,
    addApprovedMembers,
    addPermanentMembers,
    markApprovedMember,
    markPermanentMember
  };
}

module.exports = { createSubmissionStore };
