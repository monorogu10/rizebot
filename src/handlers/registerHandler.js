const { EmbedBuilder } = require('discord.js');
const { isAdmin } = require('../utils/permissions');

const LIST_PAGE_SIZE = 10;

function buildListEmbed({ entries, page, totalPages, total }) {
  const description = entries.length
    ? entries
      .map(entry => (
        `${entry.rank}. ${entry.gamertag} - <@${entry.userId}>`
      ))
      .join('\n')
    : 'Belum ada yang terdaftar.';

  return new EmbedBuilder()
    .setColor(0x2b90d9)
    .setTitle('Daftar Registrasi')
    .setDescription(description)
    .setFooter({ text: `Halaman ${page}/${totalPages} • Total ${total}` })
    .setTimestamp();
}

function buildStatusEmbed({ user, entry }) {
  if (!entry) {
    return new EmbedBuilder()
      .setColor(0xf39c12)
      .setTitle('Status Registrasi')
      .setDescription('Kamu belum terdaftar. Gunakan `!reg <gamertag>` terlebih dahulu.')
      .setTimestamp();
  }

  return new EmbedBuilder()
    .setColor(0x3bb273)
    .setTitle('Status Registrasi')
    .setDescription(
      [
        `User: <@${user.id}>`,
        `Gamertag: ${entry.gamertag}`,
        'Status: Terdaftar'
      ].join('\n')
    )
    .setTimestamp();
}

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

async function removeRoleIfPresent(member, roleId) {
  if (!member || !roleId) return false;
  if (!member.roles.cache.has(roleId)) return false;
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return false;
  await member.roles.remove(role).catch(() => null);
  return true;
}

function createRegisterHandler({ registerStore, roleId }) {
  if (!registerStore) throw new Error('registerStore is required');

  async function handleRegisterCommands(msg, content) {
    if (/^!reg-total\b/i.test(content)) {
      await registerStore.init(msg.client);
      const total = registerStore.getTotal();
      await msg.reply(`Total register: ${total}`).catch(() => null);
      return true;
    }

    if (/^!reg-reset\b/i.test(content)) {
      if (!isAdmin(msg.member)) {
        await msg.reply('Command ini hanya untuk admin.').catch(() => null);
        return true;
      }
      await registerStore.init(msg.client);
      const entries = registerStore.getEntries();
      await registerStore.resetAll();

      let removed = 0;
      const role = roleId ? msg.guild.roles.cache.get(roleId) : null;
      if (role) {
        for (const entry of entries) {
          const member = await msg.guild.members.fetch(entry.userId).catch(() => null);
          if (!member) continue;
          if (member.roles.cache.has(roleId)) {
            await member.roles.remove(role).catch(() => null);
            removed += 1;
          }
        }
      }

      const removedNote = roleId ? ` Role dihapus dari ${removed} member.` : '';
      await msg.reply(`Semua data register direset.${removedNote}`).catch(() => null);
      return true;
    }

    const listMatch = content.match(/^!list(?:\s+(\d+))?\b/i);
    if (listMatch) {
      if (!isAdmin(msg.member)) {
        await msg.reply('Command ini hanya untuk admin.').catch(() => null);
        return true;
      }
      const page = Math.max(1, Number.parseInt(listMatch[1], 10) || 1);
      await registerStore.init(msg.client);
      const entries = registerStore.getEntries();
      const totalPages = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE));
      if (!entries.length) {
        const embed = buildListEmbed({
          entries: [],
          page: 1,
          totalPages: 1,
          total: 0
        });
        await msg.reply({ embeds: [embed] }).catch(() => null);
        return true;
      }
      if (page > totalPages) {
        await msg.reply(`Halaman tidak tersedia. Total halaman: ${totalPages}.`).catch(() => null);
        return true;
      }
      const start = (page - 1) * LIST_PAGE_SIZE;
      const paged = entries.slice(start, start + LIST_PAGE_SIZE);
      const embed = buildListEmbed({
        entries: paged,
        page,
        totalPages,
        total: entries.length
      });
      await msg.reply({ embeds: [embed] }).catch(() => null);
      return true;
    }

    if (/^!status\b/i.test(content)) {
      await registerStore.init(msg.client);
      const entry = registerStore.getUser(msg.author.id);
      const embed = buildStatusEmbed({ user: msg.author, entry });
      await msg.reply({ embeds: [embed] }).catch(() => null);
      return true;
    }

    if (/^!del\b/i.test(content)) {
      await registerStore.init(msg.client);
      const removed = await registerStore.removeUser(msg.author.id);
      if (!removed) {
        await msg.reply('Kamu belum terdaftar.').catch(() => null);
        return true;
      }
      const member = await resolveMember(msg);
      await removeRoleIfPresent(member, roleId);
      await msg.reply('Data register kamu sudah dihapus.').catch(() => null);
      return true;
    }

    const editMatch = content.match(/^!edit\s+(.+)/i);
    if (/^!edit\b/i.test(content) && !editMatch) {
      await msg.reply('Format: `!edit <gamertag baru>`').catch(() => null);
      return true;
    }
    if (editMatch) {
      const gamertag = editMatch[1].trim();
      if (!gamertag) {
        await msg.reply('Format: `!edit <gamertag baru>`').catch(() => null);
        return true;
      }
      await registerStore.init(msg.client);
      const updated = await registerStore.updateUser(msg.author.id, gamertag);
      if (!updated) {
        await msg.reply('Kamu belum terdaftar. Gunakan `!reg <gamertag>` terlebih dahulu.').catch(() => null);
        return true;
      }
      await msg.reply(`Gamertag kamu diperbarui menjadi: ${gamertag}`).catch(() => null);
      return true;
    }

    const regMatch = content.match(/^!reg\s+(.+)/i);
    if (/^!reg\b/i.test(content) && !regMatch) {
      await msg.reply('Format: `!reg <gamertag>`').catch(() => null);
      return true;
    }
    if (regMatch) {
      const gamertag = regMatch[1].trim();
      if (!gamertag) {
        await msg.reply('Format: `!reg <gamertag>`').catch(() => null);
        return true;
      }
      await registerStore.init(msg.client);
      const existing = registerStore.getUser(msg.author.id);
      if (existing) {
        await msg.reply(
          `Kamu sudah terdaftar dengan gamertag: ${existing.gamertag}. Gunakan \`!edit\` atau \`!del\`.`
        ).catch(() => null);
        return true;
      }

      await registerStore.registerUser(msg.author.id, gamertag);
      const member = await resolveMember(msg);
      await addRoleIfMissing(member, roleId);

      await msg.reply(`Registrasi berhasil. Gamertag kamu: ${gamertag}`).catch(() => null);
      return true;
    }

    return false;
  }

  return async function handleRegisterMessage(msg) {
    try {
      if (!msg || msg.author?.bot) return false;
      const content = (msg.content || '').trim();
      if (!content.startsWith('!')) return false;

      if (!msg.guild) return false;

      return await handleRegisterCommands(msg, content);
    } catch (err) {
      console.error('Register handler error:', err);
      return false;
    }
  };
}

module.exports = { createRegisterHandler };
