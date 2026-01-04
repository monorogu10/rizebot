const { isAdmin } = require('../utils/permissions');

const REGISTER_PROMPT = [
  '1. tujuan join starlight?',
  '2. janji tidak akan rusuh,berkata-kata toxic dan hal buruk lainnya?',
  '3. bisa bertanggung jawab jika mengalami kesalahan?',
  'jawab dengan cara ketik !jawab dan isi pesan selanjutnya dengan jawaban di channel ini.',
  'pesan jawaban kamu akan otomatis dihapus dan dikirim langsung ke admin.',
  'contoh: !jawab Saya join karena ingin belajar dan siap mengikuti aturan.'
].join('\n');

function buildAnswerPayload({ user, gamertag, answer }) {
  const header = `Jawaban registrasi dari <@${user.id}> (${user.tag})`;
  const gamertagLine = gamertag ? `Gamertag: ${gamertag}` : 'Gamertag: -';
  const base = `${header}\n${gamertagLine}\nPesan:`;
  const maxLength = 1900 - base.length;
  const trimmed = maxLength > 0 && answer.length > maxLength
    ? `${answer.slice(0, Math.max(0, maxLength - 3))}...`
    : answer;
  return `${base}\n${trimmed}`;
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

function createRegisterHandler({ registerStore, roleId, inboxChannelId }) {
  if (!registerStore) throw new Error('registerStore is required');

  async function handleDmAnswer(msg, content) {
    if (!/^!jawab\b/i.test(content)) return false;
    await msg.reply('Silakan jawab di channel server dengan `!jawab <pesan>`.').catch(() => null);
    return true;
  }

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

    if (/^!list\b/i.test(content)) {
      await registerStore.init(msg.client);
      const entries = registerStore.getEntries();
      if (!entries.length) {
        await msg.reply('Belum ada yang terdaftar.').catch(() => null);
        return true;
      }
      const lines = entries.map(entry => (
        `${entry.rank}. ${entry.gamertag} - <@${entry.userId}> (${entry.answered ? '✅' : '❌'})`
      ));
      await msg.reply(lines.join('\n')).catch(() => null);
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

    const jawabMatch = content.match(/^!jawab\s+(.+)/i);
    if (/^!jawab\b/i.test(content) && !jawabMatch) {
      await msg.reply('Format: `!jawab <pesan>`').catch(() => null);
      return true;
    }
    if (jawabMatch) {
      const answer = jawabMatch[1].trim();
      if (!answer) {
        await msg.reply('Format: `!jawab <pesan>`').catch(() => null);
        return true;
      }

      await registerStore.init(msg.client);
      const entry = registerStore.getUser(msg.author.id);
      if (!entry) {
        await msg.reply('Kamu belum terdaftar. Gunakan `!reg <gamertag>` terlebih dahulu.').catch(() => null);
        return true;
      }

      const channel = await msg.client.channels.fetch(inboxChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        await msg.reply('Channel admin tidak ditemukan.').catch(() => null);
        return true;
      }

      const payload = buildAnswerPayload({
        user: msg.author,
        gamertag: entry?.gamertag || '',
        answer
      });

      const sent = await channel.send({ content: payload }).catch(() => null);
      if (!sent) {
        await msg.reply('Gagal mengirim pesan ke admin. Coba lagi nanti.').catch(() => null);
        return true;
      }

      await registerStore.markAnswered(msg.author.id).catch(() => null);
      await msg.delete().catch(() => null);
      const notice = await msg.channel
        .send(`${msg.author} jawaban kamu sudah terkirim ✅`)
        .catch(() => null);
      if (notice) setTimeout(() => notice.delete().catch(() => {}), 5000);
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
      const prompt = await msg.reply(REGISTER_PROMPT).catch(() => null);
      if (prompt) setTimeout(() => prompt.delete().catch(() => {}), 60000);
      return true;
    }

    return false;
  }

  return async function handleRegisterMessage(msg) {
    try {
      if (!msg || msg.author?.bot) return false;
      const content = (msg.content || '').trim();
      if (!content.startsWith('!')) return false;

      if (!msg.guild) {
        return await handleDmAnswer(msg, content);
      }

      return await handleRegisterCommands(msg, content);
    } catch (err) {
      console.error('Register handler error:', err);
      return false;
    }
  };
}

module.exports = { createRegisterHandler };
