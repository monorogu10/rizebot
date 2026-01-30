const {
  REGISTER_ROLE_ID,
  SUBMISSION_CHANNEL_ID,
  RATING_PREFIX,
  RATING_APPROVE_EMOJI,
  RATING_REJECT_EMOJI,
  RATING_FIRE_EMOJI,
  RATING_SKULL_EMOJI,
  RATING_NEUTRAL_EMOJI,
  RATING_MIN_APPROVALS,
  SUBMISSION_SCAN_LIMIT,
  SUBMISSION_SCAN_MAX_AGE_DAYS,
  SUBMISSION_SCAN_DELAY_MS,
  PRIVATE_CHAT_CHANNEL_ID
} = require('../config');

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const DEFAULT_APPROVAL_EMOJIS = [RATING_APPROVE_EMOJI, RATING_REJECT_EMOJI].filter(Boolean);
const DEFAULT_RATING_EMOJIS = [RATING_FIRE_EMOJI, RATING_SKULL_EMOJI, RATING_NEUTRAL_EMOJI].filter(Boolean);


async function resolveMember(msg) {
  if (msg.member) return msg.member;
  return msg.guild?.members.fetch(msg.author.id).catch(() => null);
}

async function addRoleIfMissing(member, roleId) {
  if (!member || !roleId) return false;
  if (member.roles.cache.has(roleId)) return true;
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return false;
  const updated = await member.roles.add(role).catch(() => null);
  if (updated?.roles?.cache?.has(roleId)) return true;
  return member.roles.cache.has(roleId);
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

async function sendNotice(msg, text) {
  const notice = await msg.channel?.send(`${msg.author}, ${text}`).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => null), 5000);
}

async function deleteWithNotice(msg, text) {
  await msg.delete().catch(() => null);
  await sendNotice(msg, text);
}

function hasBotReaction(message, emoji) {
  if (!message?.reactions?.cache) return false;
  const reaction = message.reactions.cache.find(item => item.emoji?.name === emoji);
  return Boolean(reaction?.me);
}

async function seedReactions(message, emojis = []) {
  if (!message) return;
  for (const emoji of emojis) {
    if (!emoji) continue;
    if (!hasBotReaction(message, emoji)) {
      await message.react(emoji).catch(() => null);
    }
  }
}

async function handleSubmissionMessage(msg, options) {
  const {
    roleId,
    submissionChannelId,
    ratingPrefix,
    approvalEmojis = DEFAULT_APPROVAL_EMOJIS,
    ratingEmojis = DEFAULT_RATING_EMOJIS,
    submissionStore
  } = options;

  if (!msg?.guild) return false;
  if (String(msg.channelId) !== String(submissionChannelId)) return false;
  if (msg.author?.bot) return true;

  const member = await resolveMember(msg);
  if (!member) return false;

  const hasPrivateRole = Boolean(roleId && member.roles.cache.has(roleId));

  if (!isValidSubmissionMessage(msg, ratingPrefix)) {
    await deleteWithNotice(
      msg,
      `Format wajib: \`${ratingPrefix} ini adalah karya gue\` + lampiran gambar (hanya gambar).`
    );
    return true;
  }

  const createdAt = msg.createdAt ? msg.createdAt.toISOString() : new Date().toISOString();
  if (hasPrivateRole) {
    await seedReactions(msg, ratingEmojis);
  } else {
    await seedReactions(msg, approvalEmojis);
  }

  if (submissionStore) {
    await submissionStore.init(msg.client);
    await submissionStore.upsertSubmission({
      messageId: msg.id,
      authorId: msg.author?.id || null,
      channelId: String(msg.channelId),
      createdAt,
      approvals: 0,
      approvedAt: hasPrivateRole ? createdAt : null
    });
    if (hasPrivateRole) {
      await submissionStore.markApprovedMember(msg.author.id, 'role');
    }
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
  await msg.reply(
    `Status: belum terdaftar. Kirim karya${channelHint}${prefixHint} + lampiran gambar, lalu tunggu \u2705 minimal 11.`
  ).catch(() => null);
  return true;
}

async function handleHelpCommand(msg, options) {
  const {
    submissionChannelId,
    ratingPrefix,
    approvalEmojis,
    ratingEmojis,
    minApprovals,
    privateChatChannelId
  } = options;
  const content = (msg.content || '').trim();
  if (!/^!help\b/i.test(content)) return false;
  if (!msg.guild) return false;

  const channelHint = submissionChannelId ? `<#${submissionChannelId}>` : 'channel karya';
  const prefixHint = ratingPrefix ? `\`${ratingPrefix} ini adalah karya gue\`` : '`[rate] ini adalah karya gue`';
  const approvalText = Array.isArray(approvalEmojis) && approvalEmojis.length
    ? approvalEmojis.join(' ')
    : '\u2705 \u274C';
  const ratingText = Array.isArray(ratingEmojis) && ratingEmojis.length
    ? ratingEmojis.join(' ')
    : '\uD83D\uDD25 \uD83D\uDC80 \uD83D\uDDFF';
  const approvalsText = Number.isFinite(minApprovals) ? `${minApprovals}` : '11';

  const privateChatHint = privateChatChannelId ? `<#${privateChatChannelId}>` : 'channel private chat';
  const lines = [
    '**Panduan Singkat**',
    `- Kirim karya di ${channelHint} dengan format ${prefixHint} + lampiran gambar.`,
    `- Belum punya role private: react ${approvalText}. \u274C hanya tanda tidak setuju; jika \u2705 >= ${approvalsText}, otomatis dapat role private.`,
    `- Sudah punya role private: react ${ratingText} untuk rating.`,
    '- Pesan tidak dihapus.',
    '- Cek status: `!status`.',
    '- Petisi timeout (khusus member private): `!timeout @user` (butuh 17 vote dalam 1 jam).',
    '- Veto admin: `!freedom @user`.',
    `- Moderasi cepat (khusus ${privateChatHint}): react \uD83D\uDDD1\uFE0F 5x dari member private -> pesan dihapus.`
  ];

  await msg.reply(lines.join('\n')).catch(() => null);
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
  approvalEmojis = DEFAULT_APPROVAL_EMOJIS,
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

    await seedReactions(message, approvalEmojis);

    const reaction = message.reactions.cache.find(item => item.emoji?.name === ratingApproveEmoji);
    if (!reaction) {
      if (scanDelayMs > 0) await sleep(scanDelayMs);
      continue;
    }

    const approvals = await getNonBotReactionCount(reaction);
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
  ratingPrefix = RATING_PREFIX,
  ratingApproveEmoji = RATING_APPROVE_EMOJI,
  minApprovals = RATING_MIN_APPROVALS,
  submissionStore
} = {}) {
  return async function handleSubmissionReaction(reaction, user) {
    try {
      if (!reaction || !user || user.bot) return;
      if (!reaction.partial && reaction.emoji?.name !== ratingApproveEmoji) return;
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
    } catch (err) {
      console.error('Submission reaction handler error:', err);
    }
  };
}

function createRegisterHandler({
  roleId = REGISTER_ROLE_ID,
  submissionChannelId = SUBMISSION_CHANNEL_ID,
  ratingPrefix = RATING_PREFIX,
  approvalEmojis = DEFAULT_APPROVAL_EMOJIS,
  ratingEmojis = DEFAULT_RATING_EMOJIS,
  minApprovals = RATING_MIN_APPROVALS,
  submissionStore
}) {

  return async function handleRegisterMessage(msg) {
    try {
      if (!msg || msg.author?.bot) return false;
      if (!msg.guild) return false;

      const handledSubmission = await handleSubmissionMessage(msg, {
        roleId,
        submissionChannelId,
        ratingPrefix,
        approvalEmojis,
        ratingEmojis,
        submissionStore
      });
      if (handledSubmission) return true;

      const handledHelp = await handleHelpCommand(msg, {
        submissionChannelId,
        ratingPrefix,
        approvalEmojis,
        ratingEmojis,
        minApprovals,
        privateChatChannelId: PRIVATE_CHAT_CHANNEL_ID
      });
      if (handledHelp) return true;

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


