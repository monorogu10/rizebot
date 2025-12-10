function formatCurrency(num) {
  const safe = Number.isFinite(num) ? num : 0;
  return new Intl.NumberFormat('id-ID').format(safe);
}

function formatStatsLine({ rank, userId, models, reward }) {
  const prefix = typeof rank === 'number' ? `${rank}.` : '-';
  return `${prefix} <@${userId}> — ${models} model | Rp${formatCurrency(reward)}`;
}

module.exports = {
  formatCurrency,
  formatStatsLine
};
