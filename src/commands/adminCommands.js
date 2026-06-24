const { isAdmin } = require('../utils/permissions');
const { formatCurrency } = require('../utils/format');

function formatTotals(userId, entry) {
  return `<@${userId}> | model: ${entry.models}, reward: Rp${formatCurrency(entry.reward)}`;
}

function parseValue(content, prefix) {
  const pattern = new RegExp(`^${prefix}-(\\d+)-`, 'i');
  const match = content.match(pattern);
  return match ? parseInt(match[1], 10) : null;
}

async function handleAdminCommands(msg, leaderboardStore) {
  if (!msg.guild || msg.author?.bot) return false;
  if (!isAdmin(msg.member)) return false;

  const content = (msg.content || '').trim();
  const mentionedUser = msg.mentions.users.first();

  if (/^ok\b/i.test(content)) {
    if (!mentionedUser) {
      await msg.reply('Format: `ok @user`');
      return true;
    }
    const updated = await leaderboardStore.updateUser(mentionedUser.id, {
      modelsDelta: 1,
      rewardDelta: 2000
    });
    await msg.reply(`OK dicatat. ${formatTotals(mentionedUser.id, updated)} (+1 model, +Rp2.000)`);
    return true;
  }

  if (/^nice\b/i.test(content)) {
    if (!mentionedUser) {
      await msg.reply('Format: `nice @user`');
      return true;
    }
    const updated = await leaderboardStore.updateUser(mentionedUser.id, {
      modelsDelta: 1,
      rewardDelta: 5000
    });
    await msg.reply(`Nice! ${formatTotals(mentionedUser.id, updated)} (+1 model, +Rp5.000)`);
    return true;
  }

  if (/^!reset-data\b/i.test(content)) {
    await leaderboardStore.resetAll();
    await msg.reply('Semua data leaderboard direset dan dihapus dari status.');
    return true;
  }

  const bonusValue = parseValue(content, '!bonus');
  if (bonusValue !== null) {
    if (bonusValue <= 0) {
      await msg.reply('Nilai bonus harus lebih besar dari 0.');
      return true;
    }
    if (!mentionedUser) {
      await msg.reply('Format: `!bonus-<jumlah>-@user`');
      return true;
    }
    const updated = await leaderboardStore.updateUser(mentionedUser.id, {
      modelsDelta: 0,
      rewardDelta: Math.max(0, bonusValue)
    });
    await msg.reply(`Bonus diberikan. ${formatTotals(mentionedUser.id, updated)} (+Rp${formatCurrency(bonusValue)})`);
    return true;
  }

  const minModelValue = parseValue(content, '!min-model');
  if (minModelValue !== null) {
    if (minModelValue <= 0) {
      await msg.reply('Nilai pengurangan model harus lebih besar dari 0.');
      return true;
    }
    if (!mentionedUser) {
      await msg.reply('Format: `!min-model-<jumlah>-@user`');
      return true;
    }
    const updated = await leaderboardStore.updateUser(mentionedUser.id, {
      modelsDelta: -Math.max(0, minModelValue),
      rewardDelta: 0
    });
    await msg.reply(`Model dikurangi. ${formatTotals(mentionedUser.id, updated)} (-${minModelValue} model)`);
    return true;
  }

  const minRewardValue = parseValue(content, '!min-reward');
  if (minRewardValue !== null) {
    if (minRewardValue <= 0) {
      await msg.reply('Nilai pengurangan reward harus lebih besar dari 0.');
      return true;
    }
    if (!mentionedUser) {
      await msg.reply('Format: `!min-reward-<jumlah>-@user`');
      return true;
    }
    const updated = await leaderboardStore.updateUser(mentionedUser.id, {
      modelsDelta: 0,
      rewardDelta: -Math.max(0, minRewardValue)
    });
    await msg.reply(`Reward dikurangi. ${formatTotals(mentionedUser.id, updated)} (-Rp${formatCurrency(minRewardValue)})`);
    return true;
  }

  return false;
}

module.exports = { handleAdminCommands };
