const {
  REGISTER_ROLE_ID,
  SUBMISSION_CHANNEL_ID,
  SUBMISSION_ROLE_ID,
  RATING_PREFIX,
  RATING_APPROVE_EMOJI,
  RATING_REJECT_EMOJI,
  RATING_MIN_APPROVALS,
  SUBMISSION_SCAN_LIMIT,
  SUBMISSION_SCAN_MAX_AGE_DAYS,
  SUBMISSION_SCAN_DELAY_MS
} = require('../config');

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];


async function resolveMember(msg) {
  if (msg.member) return msg.member;
  return msg.guild?.members.fetch(msg.author.id).catch(() => null);
}

async function addRoleIfMissing(member, roleId) {
  if (!member || !roleId) return false;
  if (member.roles.cache.has(roleId)) return false;
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return false;
  await member.roles.add(role).catch(() => null);
  return true;
}

function getAttachments(msg) {
  if (!msg?.attachments) return [];
  return Array.from(msg.attachments.values());
}

function isImageAttachment(attachment) {
  if (!attachment) return false;
  const contentType = typeof attachment.contentType === 'string' ? attachment.contentType.toLowerCase() : '';
  if (contentType.startsWith('image/')) return true;
  const name = typeof attachment.name === 'string' ? attachment.name.toLowerCase() : '';
  const url = typeof attachment.url === 'string' ? attachment.url.toLowerCase() : '';
  const target = name || url;
  if (!target) return false;
  return IMAGE_EXTENSIONS.some(ext => target.endsWith(ext));
}

function hasRatePrefix(content, prefix) {
  if (!prefix) return false;
  return (content || '').trim().toLowerCase().startsWith(prefix.toLowerCase());
}

function isValidSubmissionMessage(msg, prefix) {
  const attachments = getAttachments(msg);
  if (!attachments.length) return false;
  if (!attachments.every(isImageAttachment)) return false;
  return hasRatePrefix(msg?.content || '', prefix);
}

async function deleteWithNotice(msg, text) {
  await msg.delete().catch(() => null);
  const notice = await msg.channel?.send(`${msg.author}, ${text}`).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => null), 5000);
}

function hasBotReaction(message, emoji) {
  if (!message?.reactions?.cache) return false;
  const reaction = message.reactions.cache.find(item => item.emoji?.name === emoji);
  return Boolean(reaction?.me);
}

async function seedReactions(message, approveEmoji, rejectEmoji) {
  if (!message) return;
  if (approveEmoji && !hasBotReaction(message, approveEmoji)) {
    await message.react(approveEmoji).catch(() => null);
  }
  if (rejectEmoji && !hasBotReaction(message, rejectEmoji)) {
    await message.react(rejectEmoji).catch(() => null);
  }
}

async function handleSubmissionMessage(msg, options) {
  const {
    roleId,
    submissionChannelId,
    submitterRoleId,
    ratingPrefix,
    approveEmoji,
    rejectEmoji,
    submissionStore
  } = options;

  if (!msg?.guild) return false;
  if (String(msg.channelId) !== String(submissionChannelId)) return false;
  if (msg.author?.bot) return true;

  const member = await resolveMember(msg);
  if (!member) return false;

  if (roleId && member.roles.cache.has(roleId)) {
    await deleteWithNotice(msg, 'Kamu sudah punya role private, tidak bisa kirim karya di channel ini.');
    return true;
  }

  if (submitterRoleId && !member.roles.cache.has(submitterRoleId)) {
    await deleteWithNotice(msg, 'Hanya role yang diizinkan yang boleh kirim karya di channel ini.');
    return true;
  }

  if (!isValidSubmissionMessage(msg, ratingPrefix)) {
    await deleteWithNotice(
      msg,
      `Format wajib: \`${ratingPrefix} ini adalah karya gue\` + lampiran gambar (hanya gambar).`
    );
    return true;
  }

  await seedReactions(msg, approveEmoji, rejectEmoji);

  if (submissionStore) {
    await submissionStore.init(msg.client);
    await submissionStore.upsertSubmission({
      messageId: msg.id,
      authorId: msg.author?.id || null,
      channelId: String(msg.channelId),
      createdAt: msg.createdAt ? msg.createdAt.toISOString() : new Date().toISOString(),
      approvals: 0
    });
  }
  return true;
}

async function handleStatusCommand(msg, options) {
  const { roleId, submissionStore, submissionChannelId, ratingPrefix } = options;
  const content = (msg.content || '').trim();
  if (!/^!status\b/i.test(content)) return false;

  const member = await resolveMember(msg);
  const hasRole = Boolean(roleId && member?.roles?.cache?.has(roleId));
  let isRegistered = hasRole;

  if (submissionStore) {
    await submissionStore.init(msg.client);
    if (!isRegistered) {
      isRegistered = submissionStore.isApprovedMember(msg.author.id) ||
        submissionStore.isPermanentMember(msg.author.id);
    }
    if (hasRole) {
      await submissionStore.markApprovedMember(msg.author.id, 'role');
    }
  }

  if (isRegistered) {
    await msg.reply('Status: kamu sudah terdaftar di private.').catch(() => null);
    return true;
  }

  const channelHint = submissionChannelId ? ` di <#${submissionChannelId}>` : '';
  const prefixHint = ratingPrefix ? ` dengan format \`${ratingPrefix} ini adalah karya gue\`` : '';
  await msg.reply(`Status: belum terdaftar. Kirim karya${channelHint}${prefixHint} + lampiran gambar.`).catch(() => null);
  return true;
}

async function getNonBotReactionCount(reaction) {
  try {
    const users = await reaction.users.fetch();
    return users.filter(user => !user.bot).size;
  } catch {
    return reaction.count || 0;
  }
}

function isWithinAgeWindow(iso, maxAgeMs) {
  if (!iso) return true;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return true;
  return Date.now() - time <= maxAgeMs;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scanSubmissionApprovals(client, submissionStore, {
  roleId = REGISTER_ROLE_ID,
  submissionChannelId = SUBMISSION_CHANNEL_ID,
  ratingPrefix = RATING_PREFIX,
  ratingApproveEmoji = RATING_APPROVE_EMOJI,
  minApprovals = RATING_MIN_APPROVALS,
  scanLimit = SUBMISSION_SCAN_LIMIT,
  maxAgeDays = SUBMISSION_SCAN_MAX_AGE_DAYS,
  scanDelayMs = SUBMISSION_SCAN_DELAY_MS
} = {}) {
  if (!client || !submissionStore) return { scanned: 0, approved: 0 };
  await submissionStore.init(client);

  const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * 24 * 60 * 60 * 1000 : 0;
  const submissions = submissionStore.getSubmissions()
    .filter(entry => !entry.approvedAt)
    .filter(entry => entry.channelId && entry.messageId)
    .filter(entry => (maxAgeMs ? isWithinAgeWindow(entry.createdAt, maxAgeMs) : true))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, Math.max(0, scanLimit));

  let scanned = 0;
  let approved = 0;

  for (const entry of submissions) {
    const channel = await client.channels.fetch(entry.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) continue;
    if (submissionChannelId && String(channel.id) !== String(submissionChannelId)) continue;

    const message = await channel.messages.fetch(entry.messageId).catch(() => null);
    scanned += 1;
    if (!message) continue;
    if (!isValidSubmissionMessage(message, ratingPrefix)) continue;

    const reaction = message.reactions.cache.find(item => item.emoji?.name === ratingApproveEmoji);
    if (!reaction) continue;

    let approvals = reaction.count || 0;
    if (approvals < minApprovals) {
      await submissionStore.updateSubmissionApprovals(message.id, approvals);
      if (scanDelayMs > 0) await sleep(scanDelayMs);
      continue;
    }

    approvals = await getNonBotReactionCount(reaction);
    await submissionStore.updateSubmissionApprovals(message.id, approvals);
    if (approvals < minApprovals) {
      if (scanDelayMs > 0) await sleep(scanDelayMs);
      continue;
    }

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (member) {
      await addRoleIfMissing(member, roleId);
      await submissionStore.markApprovedMember(member.id, 'vote');
    }
    await submissionStore.markSubmissionApproved(message.id);
    await message.delete().catch(() => null);
    approved += 1;

    if (scanDelayMs > 0) await sleep(scanDelayMs);
  }

  return { scanned, approved };
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

function createSubmissionReactionHandler({
  roleId = REGISTER_ROLE_ID,
  submissionChannelId = SUBMISSION_CHANNEL_ID,
  submitterRoleId = SUBMISSION_ROLE_ID,
  ratingPrefix = RATING_PREFIX,
  ratingApproveEmoji = RATING_APPROVE_EMOJI,
  minApprovals = RATING_MIN_APPROVALS,
  submissionStore
} = {}) {
  return async function handleSubmissionReaction(reaction, user) {
    try {
      if (!reaction || !user || user.bot) return;
      const resolved = await resolveReaction(reaction);
      if (!resolved) return;

      const message = resolved.message;
      if (!message?.guild) return;
      if (String(message.channelId) !== String(submissionChannelId)) return;

      if (resolved.emoji?.name !== ratingApproveEmoji) return;
      if (!isValidSubmissionMessage(message, ratingPrefix)) return;

      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      if (!member) return;
      if (roleId && member.roles.cache.has(roleId)) return;
      if (submitterRoleId && !member.roles.cache.has(submitterRoleId)) return;

      const approvals = await getNonBotReactionCount(resolved);

      if (submissionStore) {
        await submissionStore.init(message.client);
        const existing = submissionStore.getSubmission(message.id);
        if (existing) {
          await submissionStore.updateSubmissionApprovals(message.id, approvals);
        } else {
          await submissionStore.upsertSubmission({
            messageId: message.id,
            authorId: message.author?.id || null,
            channelId: String(message.channelId),
            createdAt: message.createdAt ? message.createdAt.toISOString() : new Date().toISOString(),
            approvals
          });
        }
      }

      if (approvals < minApprovals) return;

      await addRoleIfMissing(member, roleId);
      if (submissionStore) {
        await submissionStore.markApprovedMember(member.id, 'vote');
        await submissionStore.markSubmissionApproved(message.id);
      }
      await message.delete().catch(() => null);
    } catch (err) {
      console.error('Submission reaction handler error:', err);
    }
  };
}

function createRegisterHandler({
  roleId = REGISTER_ROLE_ID,
  submissionChannelId = SUBMISSION_CHANNEL_ID,
  submitterRoleId = SUBMISSION_ROLE_ID,
  ratingPrefix = RATING_PREFIX,
  ratingApproveEmoji = RATING_APPROVE_EMOJI,
  ratingRejectEmoji = RATING_REJECT_EMOJI,
  submissionStore
}) {

  return async function handleRegisterMessage(msg) {
    try {
      if (!msg || msg.author?.bot) return false;
      if (!msg.guild) return false;

      const handledSubmission = await handleSubmissionMessage(msg, {
        roleId,
        submissionChannelId,
        submitterRoleId,
        ratingPrefix,
        approveEmoji: ratingApproveEmoji,
        rejectEmoji: ratingRejectEmoji,
        submissionStore
      });
      if (handledSubmission) return true;

      const handledStatus = await handleStatusCommand(msg, {
        roleId,
        submissionStore,
        submissionChannelId,
        ratingPrefix
      });
      if (handledStatus) return true;

      return false;
    } catch (err) {
      console.error('Register handler error:', err);
      return false;
    }
  };
}

module.exports = { createRegisterHandler, createSubmissionReactionHandler, scanSubmissionApprovals };


