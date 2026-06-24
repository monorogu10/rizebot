const { BOT_OUTPUT_CHANNEL_IDS } = require('../config');
const { isAdmin } = require('./permissions');

function getTargetChannelId(target) {
  if (!target) return '';
  return String(target.channelId || target.id || target.channel?.id || '');
}

function isAllowedBotOutputChannel(target) {
  if (isAdmin(target?.member)) return true;
  const channelId = getTargetChannelId(target);
  return Boolean(channelId && BOT_OUTPUT_CHANNEL_IDS.has(channelId));
}

module.exports = {
  isAllowedBotOutputChannel
};
