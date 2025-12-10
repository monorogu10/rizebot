const { PermissionsBitField } = require('discord.js');

function isAdmin(member) {
  try {
    return member?.permissions?.has(PermissionsBitField.Flags.Administrator);
  } catch {
    return false;
  }
}

module.exports = { isAdmin };
