const {
  REGISTER_ROLE_ID,
  SUBMISSION_CHANNEL_ID,
  SUBMISSION_ROLE_ID,
  RATING_PREFIX,
  RATING_APPROVE_EMOJI,
  RATING_REJECT_EMOJI,
  RATING_MIN_APPROVALS
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
    rejectEmoji
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
    await deleteWithNotice(msg, `Hanya role <@&${submitterRoleId}> yang boleh kirim karya di channel ini.`);
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
  minApprovals = RATING_MIN_APPROVALS
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
      if (approvals < minApprovals) return;

      await addRoleIfMissing(member, roleId);
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
  ratingRejectEmoji = RATING_REJECT_EMOJI
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
        rejectEmoji: ratingRejectEmoji
      });
      if (handledSubmission) return true;

      return false;
    } catch (err) {
      console.error('Register handler error:', err);
      return false;
    }
  };
}

module.exports = { createRegisterHandler, createSubmissionReactionHandler };


