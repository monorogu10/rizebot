const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const {
  LAW_ADMIN_ROLE_IDS,
  MINECRAFT_REGISTER_RESET_ADMIN_ID,
  TOPUP_ADMIN_DISCORD_ID,
} = require('../config');

const PUBLIC_PAGE_SIZE = 5;
const PUBLIC_COLLECTOR_MS = 5 * 60 * 1000;
const DRAFT_COLLECTOR_MS = 15 * 60 * 1000;

function actorFrom(source) {
  const user = source?.user || source?.author || source;
  return { id: String(user?.id || ''), name: String(user?.tag || user?.username || 'Discord Admin') };
}

function isLawAdmin(source) {
  const user = source?.user || source?.author;
  const member = source?.member;
  const id = String(user?.id || '');
  if (id && (id === TOPUP_ADMIN_DISCORD_ID || id === MINECRAFT_REGISTER_RESET_ADMIN_ID)) return true;
  if (member?.permissions?.has(PermissionsBitField.Flags.Administrator) ||
      member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return true;
  return [...LAW_ADMIN_ROLE_IDS].some(roleId => member?.roles?.cache?.has(roleId));
}

function statusText(status) {
  return ({ ACTIVE: '🟢 Berlaku', AMENDED: '🟡 Telah Direvisi', REVOKED: '🔴 Dicabut', DRAFT: '📝 Draft', ARCHIVED: '📦 Diarsipkan' })[status] || status;
}

function lawDisplayName(law) {
  return law?.number && law?.year ? `UU No. ${law.number} Tahun ${law.year}` : `Draft UU #${law?.id || '-'}`;
}

function compact(value, max = 3500) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDate(value) {
  if (!value) return '-';
  try {
    return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function articleText(article) {
  const heading = article.heading ? ` — ${article.heading}` : '';
  const paragraphs = article.paragraphs.map(item => `**(${item.number})** ${item.content}`).join('\n\n');
  return `**Pasal ${article.number}${heading}**\n${paragraphs || '*Belum ada ayat.*'}`;
}

function detailEmbed(law, articleIndex = 0, { draft = false } = {}) {
  const count = Math.max(1, law.articles.length);
  const index = Math.max(0, Math.min(articleIndex, count - 1));
  const article = law.articles[index];
  const description = article ? articleText(article) : '*Belum ada Pasal.*';
  const embed = new EmbedBuilder()
    .setColor(law.status === 'REVOKED' ? 0xe74c3c : draft ? 0xf2c94c : 0x2f80ed)
    .setTitle(compact(`${lawDisplayName(law)} — ${law.title}`, 256))
    .setDescription(compact(description, 3900))
    .addFields(
      { name: 'Status', value: statusText(law.status), inline: true },
      { name: 'Versi', value: String(law.version || 1), inline: true },
      { name: draft ? 'Dibuat' : 'Diterbitkan', value: formatDate(draft ? law.createdAt : law.publishedAt), inline: false }
    )
    .setFooter({ text: `Pasal ${article ? index + 1 : 0}/${law.articles.length} • ${law.code || `Draft ID ${law.id}`}` });
  if (law.status === 'REVOKED') embed.addFields({ name: 'Alasan Pencabutan', value: compact(law.revokeReason || '-', 1024) });
  if (law.version > 1 && law.changeNote) embed.addFields({ name: 'Catatan Versi Terbaru', value: compact(law.changeNote, 1024) });
  return embed;
}

function parseAdminLawArgs(raw) {
  const text = String(raw || '').trim();
  const split = text.split('|').map(item => item.trim());
  if (split.length >= 2) return { identifier: split.shift(), note: split.join(' | ').trim() };
  const match = text.match(/^(\S+)\s+([\s\S]+)$/);
  return match ? { identifier: match[1], note: match[2].trim() } : { identifier: text, note: '' };
}

function createLawHandler({ database, serverStatusNotifier }) {
  if (!database) throw new Error('Law handler requires database');

  async function publicPanel(msg, query = '') {
    const laws = database.listLaws({ query, limit: 100 });
    if (!laws.length) {
      await msg.reply({ content: query ? `UU dengan pencarian **${compact(query, 80)}** tidak ditemukan.` : 'Belum ada Undang-Undang Ethergeon yang diterbitkan.', allowedMentions: { repliedUser: false } });
      return;
    }
    const session = crypto.randomBytes(4).toString('hex');
    let mode = laws.length === 1 ? 'detail' : 'list';
    let listPage = 0;
    let law = laws.length === 1 ? database.getLaw(String(laws[0].id), { includeDraft: false, byId: true }) : null;
    let articlePage = 0;

    function payload(disabled = false) {
      if (mode === 'detail' && law) {
        const maxArticle = Math.max(0, law.articles.length - 1);
        articlePage = Math.max(0, Math.min(articlePage, maxArticle));
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`uu_article_prev_${session}`).setLabel('Pasal Sebelumnya').setStyle(ButtonStyle.Secondary).setDisabled(disabled || articlePage <= 0),
          new ButtonBuilder().setCustomId(`uu_back_${session}`).setLabel('Daftar UU').setStyle(ButtonStyle.Primary).setDisabled(disabled || laws.length <= 1),
          new ButtonBuilder().setCustomId(`uu_article_next_${session}`).setLabel('Pasal Berikutnya').setStyle(ButtonStyle.Secondary).setDisabled(disabled || articlePage >= maxArticle)
        );
        const components = [row];
        if (law.currentVersion > 1) {
          components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`uu_version_prev_${session}`).setLabel('Versi Lebih Lama').setStyle(ButtonStyle.Secondary).setDisabled(disabled || law.version <= 1),
            new ButtonBuilder().setCustomId(`uu_version_next_${session}`).setLabel('Versi Lebih Baru').setStyle(ButtonStyle.Secondary).setDisabled(disabled || law.version >= law.currentVersion)
          ));
        }
        return { embeds: [detailEmbed(law, articlePage)], components };
      }

      const pageCount = Math.max(1, Math.ceil(laws.length / PUBLIC_PAGE_SIZE));
      listPage = Math.max(0, Math.min(listPage, pageCount - 1));
      const pageLaws = laws.slice(listPage * PUBLIC_PAGE_SIZE, (listPage + 1) * PUBLIC_PAGE_SIZE);
      const description = pageLaws.map((item, index) => [
        `**${listPage * PUBLIC_PAGE_SIZE + index + 1}. ${lawDisplayName(item)} — ${item.title}**`,
        `${statusText(item.status)} • Versi ${item.version} • \`${item.code}\``,
      ].join('\n')).join('\n\n');
      const embed = new EmbedBuilder()
        .setColor(0x2f80ed)
        .setTitle('Undang-Undang Ethergeon')
        .setDescription(description)
        .setFooter({ text: `Halaman ${listPage + 1}/${pageCount} • ${laws.length} dokumen • pilih UU untuk membaca` });
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`uu_select_${session}`)
        .setPlaceholder('Pilih Undang-Undang')
        .setDisabled(disabled)
        .addOptions(pageLaws.map(item => ({
          label: compact(`${lawDisplayName(item)} — ${item.title}`, 100),
          value: String(item.id),
          description: compact(`${statusText(item.status)} • versi ${item.version}`, 100),
        })));
      const nav = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`uu_list_prev_${session}`).setLabel('Sebelumnya').setStyle(ButtonStyle.Secondary).setDisabled(disabled || listPage <= 0),
        new ButtonBuilder().setCustomId(`uu_list_next_${session}`).setLabel('Berikutnya').setStyle(ButtonStyle.Primary).setDisabled(disabled || listPage >= pageCount - 1)
      );
      return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), nav] };
    }

    const panel = await msg.reply({ ...payload(), allowedMentions: { repliedUser: false } });
    const collector = panel.createMessageComponentCollector({ time: PUBLIC_COLLECTOR_MS });
    collector.on('collect', async interaction => {
      if (interaction.user.id !== msg.author.id) {
        await interaction.reply({ content: 'Panel `!uu` ini hanya bisa dikendalikan oleh pembuat command.', ephemeral: true });
        return;
      }
      if (interaction.customId === `uu_select_${session}`) {
        law = database.getLaw(interaction.values[0], { byId: true });
        mode = 'detail';
        articlePage = 0;
      } else if (interaction.customId === `uu_back_${session}`) mode = 'list';
      else if (interaction.customId === `uu_list_prev_${session}`) listPage -= 1;
      else if (interaction.customId === `uu_list_next_${session}`) listPage += 1;
      else if (interaction.customId === `uu_article_prev_${session}`) articlePage -= 1;
      else if (interaction.customId === `uu_article_next_${session}`) articlePage += 1;
      else if (interaction.customId === `uu_version_prev_${session}`) {
        law = database.getLaw(String(law.id), { byId: true, version: law.version - 1 });
        articlePage = 0;
      } else if (interaction.customId === `uu_version_next_${session}`) {
        law = database.getLaw(String(law.id), { byId: true, version: law.version + 1 });
        articlePage = 0;
      }
      await interaction.update(payload());
    });
    collector.on('end', () => void panel.edit(payload(true)).catch(() => null));
  }

  async function askModal(interaction, { id, title, fields }) {
    const modalId = `${id}_${crypto.randomBytes(3).toString('hex')}`;
    const modal = new ModalBuilder().setCustomId(modalId).setTitle(title);
    for (const field of fields) {
      const input = new TextInputBuilder()
        .setCustomId(field.id)
        .setLabel(field.label)
        .setStyle(field.style || TextInputStyle.Paragraph)
        .setRequired(field.required !== false)
        .setMaxLength(field.maxLength || 1800);
      if (field.value) input.setValue(compact(field.value, field.maxLength || 1800));
      if (field.placeholder) input.setPlaceholder(field.placeholder);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }
    await interaction.showModal(modal);
    return interaction.awaitModalSubmit({ filter: submit => submit.customId === modalId && submit.user.id === interaction.user.id, time: 2 * 60 * 1000 }).catch(() => null);
  }

  async function draftPanel(msg, initialLaw) {
    const session = crypto.randomBytes(4).toString('hex');
    const actor = actorFrom(msg);
    let law = initialLaw;
    let draftArticlePage = Math.max(0, law.articles.length - 1);

    function payload(disabled = false) {
      const maxArticle = Math.max(0, law.articles.length - 1);
      draftArticlePage = Math.max(0, Math.min(draftArticlePage, maxArticle));
      const embed = detailEmbed(law, draftArticlePage, { draft: true });
      embed.setDescription([embed.data.description, '', '> Nomor resmi baru diberikan saat tombol **Terbitkan** dikonfirmasi.'].join('\n'));
      const editRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`uud_title_${session}`).setLabel('Ubah Judul').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`uud_ayat_${session}`).setLabel('Tambah Ayat').setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`uud_pasal_${session}`).setLabel('Tambah Pasal').setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`uud_preview_${session}`).setLabel('Preview').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
      );
      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`uud_prev_${session}`).setLabel('Pasal Sebelumnya').setStyle(ButtonStyle.Secondary).setDisabled(disabled || draftArticlePage <= 0),
        new ButtonBuilder().setCustomId(`uud_next_${session}`).setLabel('Pasal Berikutnya').setStyle(ButtonStyle.Secondary).setDisabled(disabled || draftArticlePage >= maxArticle),
        new ButtonBuilder().setCustomId(`uud_publish_${session}`).setLabel('Terbitkan').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`uud_cancel_${session}`).setLabel('Batalkan Draft').setStyle(ButtonStyle.Danger).setDisabled(disabled)
      );
      return { embeds: [embed], components: [editRow, actionRow] };
    }

    const panel = await msg.reply({ ...payload(), allowedMentions: { repliedUser: false } });
    const collector = panel.createMessageComponentCollector({ time: DRAFT_COLLECTOR_MS });
    collector.on('collect', async interaction => {
      if (interaction.user.id !== msg.author.id) {
        await interaction.reply({ content: 'Panel draft ini hanya bisa dikendalikan oleh admin yang membukanya.', ephemeral: true });
        return;
      }
      try {
        if (interaction.customId === `uud_preview_${session}`) {
          await interaction.reply({
            content: 'Gunakan tombol Pasal Sebelumnya/Berikutnya pada panel utama untuk memeriksa seluruh draft.',
            embeds: [detailEmbed(law, draftArticlePage, { draft: true })],
            ephemeral: true,
          });
          return;
        }
        if (interaction.customId === `uud_prev_${session}`) {
          draftArticlePage -= 1;
          await interaction.update(payload());
          return;
        }
        if (interaction.customId === `uud_next_${session}`) {
          draftArticlePage += 1;
          await interaction.update(payload());
          return;
        }
        if (interaction.customId === `uud_title_${session}`) {
          const submit = await askModal(interaction, { id: 'uu_title', title: 'Ubah Judul UU', fields: [{ id: 'title', label: 'Judul Undang-Undang', style: TextInputStyle.Short, value: law.title, maxLength: 160 }] });
          if (!submit) return;
          law = database.updateLawDraftTitle(law.id, submit.fields.getTextInputValue('title'), actor);
          await submit.reply({ content: 'Judul draft berhasil diperbarui.', ephemeral: true });
        } else if (interaction.customId === `uud_ayat_${session}`) {
          const submit = await askModal(interaction, { id: 'uu_ayat', title: 'Tambah Ayat', fields: [{ id: 'content', label: 'Isi Ayat Baru', placeholder: 'Tuliskan satu ketentuan yang jelas...', maxLength: 1800 }] });
          if (!submit) return;
          const targetArticle = law.articles[draftArticlePage]?.number;
          law = database.addLawParagraph(law.id, submit.fields.getTextInputValue('content'), actor, targetArticle);
          await submit.reply({ content: `Ayat baru ditambahkan ke Pasal ${targetArticle || 1}.`, ephemeral: true });
        } else if (interaction.customId === `uud_pasal_${session}`) {
          const submit = await askModal(interaction, { id: 'uu_pasal', title: 'Tambah Pasal', fields: [
            { id: 'heading', label: 'Nama/Topik Pasal (opsional)', style: TextInputStyle.Short, required: false, maxLength: 120 },
            { id: 'content', label: 'Isi Ayat (1)', placeholder: 'Ketentuan pertama dalam Pasal baru...', maxLength: 1800 },
          ] });
          if (!submit) return;
          law = database.addLawArticle(law.id, { heading: submit.fields.getTextInputValue('heading'), content: submit.fields.getTextInputValue('content') }, actor);
          draftArticlePage = Math.max(0, law.articles.length - 1);
          await submit.reply({ content: `Pasal ${law.articles.at(-1)?.number} berhasil ditambahkan.`, ephemeral: true });
        } else if (interaction.customId === `uud_publish_${session}`) {
          const submit = await askModal(interaction, { id: 'uu_publish', title: 'Konfirmasi Penerbitan', fields: [{ id: 'confirm', label: 'Ketik TERBITKAN untuk konfirmasi', style: TextInputStyle.Short, maxLength: 20 }] });
          if (!submit) return;
          if (submit.fields.getTextInputValue('confirm').trim().toUpperCase() !== 'TERBITKAN') {
            await submit.reply({ content: 'Konfirmasi salah. Draft tidak diterbitkan.', ephemeral: true });
            return;
          }
          law = database.publishLaw(law.id, actor);
          collector.stop('published');
          await submit.reply({ content: `✅ ${lawDisplayName(law)} berhasil diterbitkan.`, ephemeral: true });
          await panel.edit({ embeds: [detailEmbed(law, 0)], components: [] });
          await serverStatusNotifier?.notifyLawPublished?.(law, actor.name);
          return;
        } else if (interaction.customId === `uud_cancel_${session}`) {
          const submit = await askModal(interaction, { id: 'uu_cancel', title: 'Batalkan Draft', fields: [{ id: 'confirm', label: 'Ketik BATALKAN untuk konfirmasi', style: TextInputStyle.Short, maxLength: 20 }] });
          if (!submit) return;
          if (submit.fields.getTextInputValue('confirm').trim().toUpperCase() !== 'BATALKAN') {
            await submit.reply({ content: 'Konfirmasi salah. Draft tetap tersimpan.', ephemeral: true });
            return;
          }
          law = database.archiveLawDraft(law.id, actor);
          collector.stop('archived');
          await submit.reply({ content: 'Draft dibatalkan dan dipindahkan ke arsip audit.', ephemeral: true });
          await panel.edit({ embeds: [detailEmbed(law, 0, { draft: true })], components: [] });
          return;
        }
        await panel.edit(payload());
      } catch (error) {
        console.error('Law draft interaction failed:', error);
        if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: `Gagal memproses draft: ${error.message}`, ephemeral: true }).catch(() => null);
      }
    });
    collector.on('end', (_, reason) => {
      if (!['published', 'archived'].includes(reason)) void panel.edit(payload(true)).catch(() => null);
    });
  }

  async function confirmLawAction(msg, { action, law, note }) {
    const session = crypto.randomBytes(4).toString('hex');
    const label = action === 'revise' ? 'Revisi UU' : 'Cabut UU';
    const embed = new EmbedBuilder()
      .setColor(action === 'revise' ? 0xf2c94c : 0xe74c3c)
      .setTitle(`Konfirmasi ${label}`)
      .setDescription(`**${lawDisplayName(law)} — ${law.title}**`)
      .addFields({ name: action === 'revise' ? 'Catatan Perubahan' : 'Alasan Pencabutan', value: compact(note, 1024) })
      .setFooter({ text: 'Hanya admin yang menjalankan command ini yang dapat mengonfirmasi.' });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`uua_yes_${session}`).setLabel(label).setStyle(action === 'revise' ? ButtonStyle.Primary : ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`uua_no_${session}`).setLabel('Batalkan').setStyle(ButtonStyle.Secondary)
    );
    const panel = await msg.reply({ embeds: [embed], components: [row], allowedMentions: { repliedUser: false } });
    const collector = panel.createMessageComponentCollector({ time: 60_000 });
    collector.on('collect', async interaction => {
      if (interaction.user.id !== msg.author.id) {
        await interaction.reply({ content: 'Konfirmasi ini bukan milik kamu.', ephemeral: true });
        return;
      }
      if (interaction.customId === `uua_no_${session}`) {
        collector.stop('cancelled');
        await interaction.update({ content: 'Aksi dibatalkan.', embeds: [], components: [] });
        return;
      }
      try {
        const actor = actorFrom(msg);
        const result = action === 'revise'
          ? database.reviseLaw(law.code || String(law.number), note, actor)
          : database.revokeLaw(law.code || String(law.number), note, actor);
        collector.stop('confirmed');
        await interaction.update({ content: `✅ ${label} berhasil diproses untuk ${lawDisplayName(result)}.`, embeds: [detailEmbed(result, Math.max(0, result.articles.length - 1))], components: [] });
        if (action === 'revise') await serverStatusNotifier?.notifyLawRevised?.(result, actor.name);
        else await serverStatusNotifier?.notifyLawRevoked?.(result, actor.name);
      } catch (error) {
        collector.stop('failed');
        await interaction.update({ content: `Gagal: ${error.message}`, embeds: [], components: [] });
      }
    });
    collector.on('end', (_, reason) => {
      if (reason === 'time') void panel.edit({ components: [], content: 'Konfirmasi kedaluwarsa; tidak ada perubahan yang dilakukan.' }).catch(() => null);
    });
  }

  return async function handleLaw(msg) {
    if (!msg || msg.author?.bot) return false;
    const raw = String(msg.content || '').trim();
    let match;

    if ((match = raw.match(/^!create-uu(?:\s+([\s\S]+))?$/i))) {
      if (!isLawAdmin(msg)) {
        await msg.reply({ content: 'Command ini khusus Administrator/Manage Server atau role admin UU.', allowedMentions: { repliedUser: false } });
        return true;
      }
      const note = String(match[1] || '').trim();
      if (!note) {
        await msg.reply({ content: 'Format: `!create-uu [catatan awal]`\nContoh: `!create-uu Setiap warga wajib menjaga ketertiban umum.`', allowedMentions: { repliedUser: false } });
        return true;
      }
      try {
        const law = database.createLawDraft({ note, actor: actorFrom(msg) });
        await draftPanel(msg, law);
      } catch (error) {
        await msg.reply({ content: `Gagal membuat draft UU: ${error.message}`, allowedMentions: { repliedUser: false } });
      }
      return true;
    }

    if ((match = raw.match(/^!(?:draft-uu|edit-uu)(?:\s+(\d+))?$/i))) {
      if (!isLawAdmin(msg)) {
        await msg.reply({ content: 'Command ini khusus admin UU.', allowedMentions: { repliedUser: false } });
        return true;
      }
      const requestedId = match[1];
      const law = requestedId
        ? database.getLaw(requestedId, { includeDraft: true, byId: true })
        : database.listLaws({ includeDraft: true, creatorId: msg.author.id, limit: 100 }).find(item => item.status === 'DRAFT');
      const full = law?.articles ? law : law ? database.getLaw(String(law.id), { includeDraft: true, byId: true }) : null;
      if (!full || full.status !== 'DRAFT') {
        await msg.reply({ content: 'Draft UU aktif tidak ditemukan. Buat dengan `!create-uu [catatan]`.', allowedMentions: { repliedUser: false } });
        return true;
      }
      await draftPanel(msg, full);
      return true;
    }

    if ((match = raw.match(/^!revise-uu(?:\s+([\s\S]+))?$/i))) {
      if (!isLawAdmin(msg)) {
        await msg.reply({ content: 'Command ini khusus admin UU.', allowedMentions: { repliedUser: false } });
        return true;
      }
      const args = parseAdminLawArgs(match[1]);
      const law = database.getLaw(args.identifier);
      if (!law || !args.note) {
        await msg.reply({ content: 'Format: `!revise-uu <nomor/kode> | <catatan perubahan>`', allowedMentions: { repliedUser: false } });
        return true;
      }
      await confirmLawAction(msg, { action: 'revise', law, note: args.note });
      return true;
    }

    if ((match = raw.match(/^!cabut-uu(?:\s+([\s\S]+))?$/i))) {
      if (!isLawAdmin(msg)) {
        await msg.reply({ content: 'Command ini khusus admin UU.', allowedMentions: { repliedUser: false } });
        return true;
      }
      const args = parseAdminLawArgs(match[1]);
      const law = database.getLaw(args.identifier);
      if (!law || !args.note) {
        await msg.reply({ content: 'Format: `!cabut-uu <nomor/kode> | <alasan pencabutan>`', allowedMentions: { repliedUser: false } });
        return true;
      }
      await confirmLawAction(msg, { action: 'revoke', law, note: args.note });
      return true;
    }

    if ((match = raw.match(/^!uu(?:\s+([\s\S]+))?$/i))) {
      await publicPanel(msg, String(match[1] || '').trim());
      return true;
    }
    return false;
  };
}

module.exports = { createLawHandler, isLawAdmin, lawDisplayName, parseAdminLawArgs };
