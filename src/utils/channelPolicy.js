const {
  BOT_OUTPUT_CHANNEL_IDS,
  INTERVIEW_ADMIN_ROLE_IDS,
} = require('../config');
const { isAdmin } = require('./permissions');

function getTargetChannelId(target) {
  if (!target) return '';
  return String(target.channelId || target.id || target.channel?.id || '');
}

function memberHasAnyRole(member, roleIds) {
  if (!member || !roleIds?.size) return false;
  const roles = member.roles;
  if (roles?.cache) {
    for (const roleId of roleIds) {
      if (roles.cache.has(roleId)) return true;
    }
    return false;
  }
  if (Array.isArray(roles)) return roles.some(roleId => roleIds.has(String(roleId)));
  if (Array.isArray(member._roles)) return member._roles.some(roleId => roleIds.has(String(roleId)));
  if (roles instanceof Set) {
    for (const roleId of roleIds) {
      if (roles.has(roleId)) return true;
    }
  }
  return false;
}

function isAllowedBotOutputChannel(target) {
  if (isAdmin(target?.member)) return true;
  if (memberHasAnyRole(target?.member, INTERVIEW_ADMIN_ROLE_IDS)) return true;
  const channelId = getTargetChannelId(target);
  return Boolean(channelId && BOT_OUTPUT_CHANNEL_IDS.has(channelId));
}

module.exports = {
  isAllowedBotOutputChannel
};
