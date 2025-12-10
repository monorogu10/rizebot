const { formatCurrency, formatStatsLine } = require('../utils/format');
const { COMMAND_CHANNELS } = require('../config');

function sortByReward(entries) {
  return [...entries].sort((a, b) => {
    if (b.reward !== a.reward) return b.reward - a.reward;
    return b.models - a.models;
  });
}

async function handleStatusCommand(msg, leaderboardStore) {
  if ((msg.content || '').trim().toLowerCase() !== '!status') return false;

  if (!COMMAND_CHANNELS.has(String(msg.channelId))) {
    await msg.reply('Command hanya bisa dipakai di channel yang ditentukan.');
    return true;
  }

  const leaderboard = leaderboardStore.getLeaderboard();
  const topByModel = leaderboard.slice(0, 10);
  const topByReward = sortByReward(leaderboard).slice(0, 10);
  const userEntry = leaderboardStore.getUser(msg.author.id);
  const modelRank = leaderboard.findIndex(entry => entry.userId === msg.author.id) + 1;
  const rewardRank = sortByReward(leaderboard).findIndex(entry => entry.userId === msg.author.id) + 1;

  const lines = [];
  lines.push('**Top Model**');
  lines.push(
    topByModel.length
      ? topByModel.map((entry, idx) => formatStatsLine({ rank: idx + 1, ...entry })).join('\n')
      : 'Belum ada data.'
  );
  lines.push('');
  lines.push('**Top Reward**');
  lines.push(
    topByReward.length
      ? topByReward.map((entry, idx) => formatStatsLine({ rank: idx + 1, ...entry })).join('\n')
      : 'Belum ada data.'
  );
  lines.push('');
  lines.push('**Status Kamu**');
  if (userEntry) {
    lines.push(
      [
        `Model: ${userEntry.models} (${modelRank || '-'} di leaderboard)`,
        `Reward: Rp${formatCurrency(userEntry.reward)} (${rewardRank || '-'} di reward)`
      ].join(' | ')
    );
  } else {
    lines.push('Belum ada catatan untukmu.');
  }

  await msg.reply(lines.join('\n'));
  return true;
}

module.exports = { handleStatusCommand };
