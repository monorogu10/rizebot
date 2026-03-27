const { PermissionsBitField } = require('discord.js');

function isAdmin(member) {
  try {
    const perms = member?.permissions;
    if (!perms) return false;
    return perms.has(PermissionsBitField.Flags.Administrator) ||
      perms.has(PermissionsBitField.Flags.ManageGuild);
  } catch {
    return false;
  }
}

module.exports = { isAdmin };
