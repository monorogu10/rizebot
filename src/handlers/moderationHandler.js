const { isAdmin } = require('../utils/permissions');
const {
  REGISTER_ROLE_ID,
  PRIVATE_CHAT_CHANNEL_ID,
  TRASH_EMOJI,
  TRASH_MIN_COUNT,
  PETITION_VOTE_EMOJI,
  PETITION_MIN_VOTES,
  PETITION_WINDOW_MS,
  TIMEOUT_DURATION_MS
} = require('../config');

const petitionTimers = new Map();

async function resolveMember(msg) {
  if (msg.member) return msg.member;
  return msg.guild?.members.fetch(msg.author.id).catch(() => null);
}

async function resolveReaction(reaction) {
  if (!reaction) return null;
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return null;
    }
  }
  const message = reaction.message;
  if (message?.partial) {
    try {
      await message.fetch();
    } catch {
      return null;
    }
  }
  return reaction;
}

function formatPetitionText(petition, voteCount, minVotes, voteEmoji) {
  const endTs = Math.floor(new Date(petition.expiresAt).getTime() / 1000);
  const tally = `${voteCount}/${minVotes}`;
  return [
    `Petisi timeout untuk <@${petition.targetId}>`,
    `Vote: ${tally} ${voteEmoji}`,
    `Batas waktu: <t:${endTs}:R>`,
    `React ${voteEmoji} untuk mendukung.`
  ].join('\n');
}

async function updatePetitionMessage(client, petition, text) {
  if (!client || !petition) return;
  const channel = await client.channels.fetch(petition.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  const message = await channel.messages.fetch(petition.messageId).catch(() => null);
  if (!message) return;
  await message.edit(text).catch(() => null);
}

async function applyTimeout(guild, targetId, durationMs, reason) {
  if (!guild || !targetId) return false;
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return false;
  await member.timeout(durationMs, reason).catch(() => null);
  return true;
}

async function removeTimeout(guild, targetId, reason) {
  if (!guild || !targetId) return false;
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) return false;
  await member.timeout(null, reason).catch(() => null);
  return true;
}

async function expirePetition(client, moderationStore, petition, options) {
  if (!petition || petition.status !== 'active') return;
  const updated = await moderationStore.setStatus(petition.petitionId, 'expired', {
    expiredAt: new Date().toISOString()
  });
  if (!updated) return;
  const text = `Petisi timeout untuk <@${updated.targetId}> gagal (waktu habis).`;
  await updatePetitionMessage(client, updated, text);
}

function schedulePetitionExpiry(client, moderationStore, petition, options) {
  if (!petition || petition.status !== 'active') return;
  if (petitionTimers.has(petition.petitionId)) return;
  const expiresAt = new Date(petition.expiresAt).getTime();
  const delay = expiresAt - Date.now();
  const run = async () => {
    petitionTimers.delete(petition.petitionId);
    await expirePetition(client, moderationStore, petition, options);
  };
  if (delay <= 0) {
    void run();
    return;
  }
  petitionTimers.set(petition.petitionId, setTimeout(run, delay));
}

async function syncActivePetitions(client, moderationStore, options) {
  await moderationStore.init(client);
  const petitions = moderationStore.getActivePetitions();
  for (const petition of petitions) {
    schedulePetitionExpiry(client, moderationStore, petition, options);
  }
}

async function handleTimeoutCommand(msg, options) {
  const {
    privateRoleId,
    moderationStore,
    petitionVoteEmoji,
    petitionMinVotes,
    petitionWindowMs
  } = options;
  const content = (msg.content || '').trim();
  if (!/^!timeout\b/i.test(content)) return false;
  if (!msg.guild) return false;

  const member = await resolveMember(msg);
  if (!member || !member.roles.cache.has(privateRoleId)) {
    await msg.reply('Command ini hanya untuk member private.').catch(() => null);
    return true;
  }

  const target = msg.mentions.users.first();
  if (!target) {
    await msg.reply('Format: `!timeout @user`').catch(() => null);
    return true;
  }
  if (target.bot) {
    await msg.reply('Tidak bisa membuat petisi untuk bot.').catch(() => null);
    return true;
  }

  await moderationStore.init(msg.client);
  const existing = moderationStore.getActivePetitionByTarget(msg.guild.id, target.id);
  if (existing) {
    await msg.reply(`Petisi untuk <@${target.id}> sudah aktif.`).catch(() => null);
    return true;
  }

  const expiresAt = new Date(Date.now() + petitionWindowMs).toISOString();
  const petitionMessage = await msg.channel.send(
    `Petisi timeout untuk <@${target.id}> dibuat. React ${petitionVoteEmoji} untuk vote.`
  );
  await petitionMessage.react(petitionVoteEmoji).catch(() => null);

  const petition = await moderationStore.createPetition({
    guildId: msg.guild.id,
    channelId: msg.channel.id,
    messageId: petitionMessage.id,
    targetId: target.id,
    creatorId: msg.author.id,
    createdAt: new Date().toISOString(),
    expiresAt
  });

  if (petition) {
    const text = formatPetitionText(petition, petition.votes.length, petitionMinVotes, petitionVoteEmoji);
    await petitionMessage.edit(text).catch(() => null);
    schedulePetitionExpiry(msg.client, moderationStore, petition, options);
  }

  return true;
}

async function handleFreedomCommand(msg, options) {
  const { moderationStore } = options;
  const content = (msg.content || '').trim();
  if (!/^!freedom\b/i.test(content)) return false;
  if (!msg.guild) return false;
  if (!isAdmin(msg.member)) {
    await msg.reply('Command ini hanya untuk admin.').catch(() => null);
    return true;
  }

  const target = msg.mentions.users.first();
  if (!target) {
    await msg.reply('Format: `!freedom @user`').catch(() => null);
    return true;
  }

  await moderationStore.init(msg.client);
  const petition = moderationStore.getActivePetitionByTarget(msg.guild.id, target.id);
  if (petition) {
    await moderationStore.setStatus(petition.petitionId, 'cancelled', {
      cancelledAt: new Date().toISOString(),
      cancelledBy: msg.author.id
    });
    petitionTimers.delete(petition.petitionId);
    const text = `Petisi timeout untuk <@${petition.targetId}> dibatalkan admin.`;
    await updatePetitionMessage(msg.client, petition, text);
  }

  const removed = await removeTimeout(msg.guild, target.id, 'Freedom by admin');
  if (removed) {
    await msg.reply(`Timeout <@${target.id}> dibatalkan.`).catch(() => null);
  } else {
    await msg.reply(`Tidak ada timeout aktif untuk <@${target.id}> atau gagal menghapus.`).catch(() => null);
  }
  return true;
}

async function handlePetitionVote(reaction, user, options) {
  const {
    privateRoleId,
    moderationStore,
    petitionVoteEmoji,
    petitionMinVotes,
    petitionWindowMs,
    timeoutDurationMs
  } = options;
  if (!reaction || !user || user.bot) return false;

  const resolved = await resolveReaction(reaction);
  if (!resolved) return false;
  if (resolved.emoji?.name !== petitionVoteEmoji) return false;

  const message = resolved.message;
  if (!message?.guild) return false;

  await moderationStore.init(message.client);
  const petition = moderationStore.getPetition(message.id);
  if (!petition || petition.status !== 'active') return false;

  const now = Date.now();
  const expiresAt = new Date(petition.expiresAt).getTime();
  if (now > expiresAt) {
    await expirePetition(message.client, moderationStore, petition, options);
    return true;
  }

  const voterMember = await message.guild.members.fetch(user.id).catch(() => null);
  if (!voterMember || !voterMember.roles.cache.has(privateRoleId)) return false;

  const { added, petition: updatedPetition } = await moderationStore.addVote(petition.petitionId, user.id);
  if (!added || !updatedPetition) return true;

  const voteCount = updatedPetition.votes.length;
  const text = formatPetitionText(updatedPetition, voteCount, petitionMinVotes, petitionVoteEmoji);
  await updatePetitionMessage(message.client, updatedPetition, text);

  if (voteCount < petitionMinVotes) return true;

  const success = await applyTimeout(
    message.guild,
    updatedPetition.targetId,
    timeoutDurationMs,
    'Timeout hasil petisi member'
  );
  if (success) {
    await moderationStore.setStatus(updatedPetition.petitionId, 'approved', {
      approvedAt: new Date().toISOString(),
      approvedBy: 'vote'
    });
    petitionTimers.delete(updatedPetition.petitionId);
    const successText = `Petisi disetujui. <@${updatedPetition.targetId}> timeout 1 hari.`;
    await updatePetitionMessage(message.client, updatedPetition, successText);
  }

  return true;
}

async function handleTrashReaction(reaction, user, options) {
  const { privateRoleId, trashEmoji, trashMinCount, privateChatChannelId } = options;
  if (!reaction || !user || user.bot) return false;

  const resolved = await resolveReaction(reaction);
  if (!resolved) return false;
  const emojiName = resolved.emoji?.name;
  if (emojiName !== trashEmoji && emojiName !== '\uD83D\uDDD1') return false;

  const message = resolved.message;
  if (!message?.guild) return false;
  if (privateChatChannelId && String(message.channelId) !== String(privateChatChannelId)) return false;
  if (message.author?.bot) return false;

  const authorMember = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (authorMember && isAdmin(authorMember)) return false;

  const voterMember = await message.guild.members.fetch(user.id).catch(() => null);
  if (!voterMember || !voterMember.roles.cache.has(privateRoleId)) return false;

  if ((resolved.count || 0) < trashMinCount) return true;

  const users = await resolved.users.fetch().catch(() => null);
  if (!users) return true;

  let count = 0;
  for (const [userId, voter] of users) {
    if (voter.bot) continue;
    const member = await message.guild.members.fetch(userId).catch(() => null);
    if (!member || !member.roles.cache.has(privateRoleId)) continue;
    count += 1;
    if (count >= trashMinCount) break;
  }

  if (count >= trashMinCount) {
    await message.delete().catch(() => null);
  }
  return true;
}

function createModerationHandler({
  moderationStore,
  privateRoleId = REGISTER_ROLE_ID,
  petitionVoteEmoji = PETITION_VOTE_EMOJI,
  petitionMinVotes = PETITION_MIN_VOTES,
  petitionWindowMs = PETITION_WINDOW_MS
} = {}) {
  if (!moderationStore) throw new Error('moderationStore is required');

  return async function handleModerationMessage(msg) {
    try {
      if (!msg || msg.author?.bot) return false;
      if (!msg.guild) return false;

      const handledTimeout = await handleTimeoutCommand(msg, {
        privateRoleId,
        moderationStore,
        petitionVoteEmoji,
        petitionMinVotes,
        petitionWindowMs
      });
      if (handledTimeout) return true;

      const handledFreedom = await handleFreedomCommand(msg, { moderationStore });
      if (handledFreedom) return true;

      return false;
    } catch (err) {
      console.error('Moderation handler error:', err);
      return false;
    }
  };
}

function createModerationReactionHandler({
  moderationStore,
  privateRoleId = REGISTER_ROLE_ID,
  petitionVoteEmoji = PETITION_VOTE_EMOJI,
  petitionMinVotes = PETITION_MIN_VOTES,
  petitionWindowMs = PETITION_WINDOW_MS,
  timeoutDurationMs = TIMEOUT_DURATION_MS,
  trashEmoji = TRASH_EMOJI,
  trashMinCount = TRASH_MIN_COUNT,
  privateChatChannelId = PRIVATE_CHAT_CHANNEL_ID
} = {}) {
  if (!moderationStore) throw new Error('moderationStore is required');

  return async function handleModerationReaction(reaction, user) {
    try {
      if (!reaction || !user || user.bot) return false;
      if (!reaction.message?.guild && !reaction.message?.partial) return false;

      const handledPetition = await handlePetitionVote(reaction, user, {
        privateRoleId,
        moderationStore,
        petitionVoteEmoji,
        petitionMinVotes,
        petitionWindowMs,
        timeoutDurationMs
      });
      if (handledPetition) return true;

      const handledTrash = await handleTrashReaction(reaction, user, {
        privateRoleId,
        trashEmoji,
        trashMinCount,
        privateChatChannelId
      });
      if (handledTrash) return true;

      return false;
    } catch (err) {
      console.error('Moderation reaction handler error:', err);
      return false;
    }
  };
}

module.exports = {
  createModerationHandler,
  createModerationReactionHandler,
  syncActivePetitions
};
