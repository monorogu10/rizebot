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
  const paragraphs = article.paragraphs.map(item => item.status === 'REPEALED'
    ? `**(${item.number})** ~~${item.content}~~\n> **Dicabut:** ${item.repealNote || 'Tanpa catatan'}`
    : `**(${item.number})** ${item.content}`).join('\n\n');
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
      { name: 'Status', value: draft && law.baseVersion > 0 ? '📝 Draft Revisi (belum berlaku)' : statusText(law.status), inline: true },
      { name: 'Versi', value: String(law.version || 1), inline: true },
      { name: draft ? 'Dibuat' : 'Diterbitkan', value: formatDate(draft ? law.versionCreatedAt || law.createdAt : law.versionPublishedAt || law.publishedAt), inline: false }
    )
    .setFooter({ text: `Pasal ${article ? index + 1 : 0}/${law.articles.length} • ${law.code || `Draft ID ${law.id}`}` });
  if (law.status === 'REVOKED') embed.addFields({ name: 'Alasan Pencabutan', value: compact(law.revokeReason || '-', 1024) });
  if (draft && law.baseVersion > 0) {
    embed.addFields(
      { name: 'Jenis Draft', value: `Revisi versi ${law.baseVersion} → ${law.version}`, inline: true },
      { name: 'Autosave', value: formatDate(law.versionUpdatedAt), inline: true },
      { name: 'Alasan Revisi', value: compact(law.changeNote || '-', 1024), inline: false }
    );
  }
  if (!draft && law.version > 1 && law.changeNote) embed.addFields({ name: 'Catatan Versi Terbaru', value: compact(law.changeNote, 1024) });
  return embed;
}

function parseAdminLawArgs(raw) {
  const text = String(raw || '').trim();
  const split = text.split('|').map(item => item.trim());
  if (split.length >= 2) return { identifier: split.shift(), note: split.join(' | ').trim() };
  const match = text.match(/^(\S+)\s+([\s\S]+)$/);
  return match ? { identifier: match[1], note: match[2].trim() } : { identifier: text, note: '' };
}

function parseRevisionArgs(raw) {
  const text = String(raw || '').trim();
  if (!text) return { identifier: '', note: '' };
  const separator = text.indexOf('|');
  if (separator < 0) return { identifier: text, note: '' };
  return {
    identifier: text.slice(0, separator).trim(),
    note: text.slice(separator + 1).trim(),
  };
}

function revisionDiffText(diff) {
  if (!diff?.changes?.length) return 'Belum ada perubahan terhadap versi yang sedang berlaku.';
  const lines = [`Versi ${diff.baseVersion} → Draft ${diff.draftVersion}`, ''];
  for (const change of diff.changes.slice(0, 30)) {
    if (change.type === 'ADD_ARTICLE') {
      lines.push(`+ Pasal ${change.article}${change.heading ? ` — ${change.heading}` : ''} ditambahkan.`);
    } else if (change.type === 'ADD_PARAGRAPH') {
      lines.push(`+ Pasal ${change.article} Ayat (${change.paragraph}): ${compact(change.after, 180)}`);
    } else if (change.type === 'UPDATE_PARAGRAPH') {
      lines.push(`~ Pasal ${change.article} Ayat (${change.paragraph}) diubah.`);
    } else if (change.type === 'REPEAL_PARAGRAPH') {
      lines.push(`- Pasal ${change.article} Ayat (${change.paragraph}) dicabut: ${compact(change.note, 160)}`);
    } else if (change.type === 'UPDATE_ARTICLE_HEADING') {
      lines.push(`~ Judul Pasal ${change.article}: ${change.before || '(kosong)'} → ${change.after || '(kosong)'}`);
    } else if (change.type === 'UPDATE_TITLE') {
      lines.push(`~ Judul UU: ${change.before} → ${change.after}`);
    } else {
      lines.push(`~ ${change.type} pada Pasal ${change.article || '-'}.`);
    }
  }
  if (diff.changes.length > 30) lines.push(`…dan ${diff.changes.length - 30} perubahan lainnya.`);
  return compact(lines.join('\n'), 3900);
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

  function tutorialPayload() {
    return {
      embeds: [new EmbedBuilder()
        .setColor(0x2f80ed)
        .setTitle('Tutorial Undang-Undang Ethergeon')
        .setDescription('UU publik tidak pernah diedit langsung. Pembuatan dan revisi selalu memakai draft autosave, lalu baru berlaku setelah diterbitkan.')
        .addFields(
          {
            name: 'Membaca UU (semua player)',
            value: [
              '`!uu` — buka daftar UU.',
              '`!uu <nomor/kode/kata>` — cari dan buka UU tertentu.',
              '`!uu-help` — buka tutorial ini.',
            ].join('\n'),
          },
          {
            name: 'Membuat UU baru (admin)',
            value: [
              '`!create-uu <isi awal>` — membuat Draft Pasal 1 Ayat (1).',
              'Di editor: atur Judul UU/Pasal, tambah Ayat/Pasal, lalu Preview.',
              'Tekan **Terbitkan UU**, kemudian ketik `TERBITKAN`.',
              '`!draft-uu [ID/kode]` / `!edit-uu [ID/kode]` — buka kembali draft yang tersimpan.',
            ].join('\n'),
          },
          {
            name: 'Merevisi UU aktif (admin)',
            value: [
              '`!revise-uu` — pilih UU, lalu pilih Pasal yang ingin dibuka.',
              '`!revise-uu <kode>` — langsung pilih Pasal pada UU tersebut.',
              '`!revise-uu <kode> | <alasan>` — siapkan alasan tanpa modal tambahan.',
              'Gunakan **Tambah Ayat**, **Ubah Ayat**, **Cabut/Pulihkan**, atau **Tambah Pasal**.',
              'Periksa **Lihat Perubahan**, lalu ketik `TERBITKAN REVISI` untuk menerbitkan.',
              '`!edit-uu <kode>` — lanjutkan draft revisi setelah editor ditutup/kedaluwarsa.',
            ].join('\n'),
          },
          {
            name: 'Mencabut UU (admin)',
            value: '`!cabut-uu <nomor/kode> | <alasan>` — mencabut UU tanpa menghapus isi dan riwayat versinya.',
          },
          {
            name: 'Catatan keamanan',
            value: 'Editor menyimpan otomatis. Satu UU hanya memiliki satu draft revisi aktif. Publish membuat backup SQLite dan JSON. Versi lama tetap dapat dibaca dari riwayat `!uu`.',
          }
        )
        .setFooter({ text: 'Admin UU: Administrator, Manage Server, pemilik bot, atau role LAW_ADMIN_ROLE_IDS.' })],
      allowedMentions: { repliedUser: false },
    };
  }

  async function revisionStartPanel(msg, { identifier = '', note = '' } = {}) {
    const laws = database.listLaws({ limit: 500 }).filter(item => ['ACTIVE', 'AMENDED'].includes(item.status));
    if (!laws.length) {
      await msg.reply({ content: 'Belum ada UU aktif yang dapat direvisi.', allowedMentions: { repliedUser: false } });
      return;
    }
    let selectedLaw = identifier ? database.getLaw(identifier) : null;
    if (identifier && !selectedLaw) {
      await msg.reply({ content: `UU \`${compact(identifier, 100)}\` tidak ditemukan. Jalankan \`!revise-uu\` untuk memilih dari daftar.`, allowedMentions: { repliedUser: false } });
      return;
    }
    if (selectedLaw?.status === 'REVOKED') {
      await msg.reply({ content: 'UU yang sudah dicabut tidak dapat direvisi.', allowedMentions: { repliedUser: false } });
      return;
    }

    const session = crypto.randomBytes(4).toString('hex');
    let mode = selectedLaw ? 'article' : 'law';
    let page = 0;
    const pageSize = 25;

    function payload(disabled = false) {
      const source = mode === 'law' ? laws : selectedLaw.articles;
      const pages = Math.max(1, Math.ceil(source.length / pageSize));
      page = Math.max(0, Math.min(page, pages - 1));
      const items = source.slice(page * pageSize, (page + 1) * pageSize);
      const embed = new EmbedBuilder()
        .setColor(0xf2c94c)
        .setTitle(mode === 'law' ? 'Pilih UU yang Akan Direvisi' : `${lawDisplayName(selectedLaw)} — Pilih Pasal`)
        .setDescription(mode === 'law'
          ? 'Versi publik tetap berlaku selama editor revisi dibuka.'
          : `${selectedLaw.title}\n\nPilih Pasal awal. Setelah itu editor dapat berpindah ke Pasal lain.`)
        .setFooter({ text: `Halaman ${page + 1}/${pages} • panel hanya untuk ${msg.author.username || msg.author.id}` });
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`uur_select_${session}`)
        .setPlaceholder(mode === 'law' ? 'Pilih Undang-Undang' : 'Pilih Pasal untuk dibuka')
        .setDisabled(disabled)
        .addOptions(items.map(item => mode === 'law' ? {
          label: compact(`${lawDisplayName(item)} — ${item.title}`, 100),
          value: String(item.id),
          description: compact(`${item.code} • versi ${item.version}`, 100),
        } : {
          label: compact(`Pasal ${item.number}${item.heading ? ` — ${item.heading}` : ''}`, 100),
          value: String(item.number),
          description: `${item.paragraphs.length} ayat`,
        }));
      const nav = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`uur_prev_${session}`).setLabel('Sebelumnya').setStyle(ButtonStyle.Secondary).setDisabled(disabled || page <= 0),
        new ButtonBuilder().setCustomId(`uur_back_${session}`).setLabel('Pilih UU Lain').setStyle(ButtonStyle.Secondary).setDisabled(disabled || mode === 'law' || Boolean(identifier)),
        new ButtonBuilder().setCustomId(`uur_next_${session}`).setLabel('Berikutnya').setStyle(ButtonStyle.Primary).setDisabled(disabled || page >= pages - 1),
        new ButtonBuilder().setCustomId(`uur_cancel_${session}`).setLabel('Batalkan').setStyle(ButtonStyle.Danger).setDisabled(disabled)
      );
      return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), nav] };
    }

    const panel = await msg.reply({ ...payload(), allowedMentions: { repliedUser: false } });
    const collector = panel.createMessageComponentCollector({ time: 5 * 60 * 1000 });
    collector.on('collect', async interaction => {
      if (interaction.user.id !== msg.author.id) {
        await interaction.reply({ content: 'Panel revisi ini bukan milik kamu.', ephemeral: true });
        return;
      }
      try {
        if (interaction.customId === `uur_prev_${session}`) {
          page -= 1;
          await interaction.update(payload());
          return;
        }
        if (interaction.customId === `uur_next_${session}`) {
          page += 1;
          await interaction.update(payload());
          return;
        }
        if (interaction.customId === `uur_back_${session}`) {
          selectedLaw = null;
          mode = 'law';
          page = 0;
          await interaction.update(payload());
          return;
        }
        if (interaction.customId === `uur_cancel_${session}`) {
          collector.stop('cancelled');
          await interaction.update({ content: 'Pemilihan revisi dibatalkan; tidak ada data yang berubah.', embeds: [], components: [] });
          return;
        }
        if (interaction.customId !== `uur_select_${session}`) return;
        if (mode === 'law') {
          selectedLaw = database.getLaw(interaction.values[0], { byId: true });
          mode = 'article';
          page = 0;
          await interaction.update(payload());
          return;
        }

        const articleNumber = Number(interaction.values[0]);
        let revisionNote = note;
        let submit = null;
        const existing = database.getLawRevisionDraft(String(selectedLaw.id), { byId: true });
        if (!existing && !revisionNote) {
          submit = await askModal(interaction, { id: 'uu_revision_note', title: 'Alasan Revisi UU', fields: [{
            id: 'note',
            label: 'Alasan/Catatan Revisi',
            placeholder: 'Contoh: penambahan ketentuan kepemilikan item...',
            maxLength: 1800,
          }] });
          if (!submit) return;
          revisionNote = submit.fields.getTextInputValue('note');
        } else {
          await interaction.deferUpdate();
        }
        const draft = existing || database.createLawRevisionDraft(selectedLaw.code || String(selectedLaw.id), revisionNote, actorFrom(msg));
        if (submit) await submit.reply({ content: `Draft revisi versi ${draft.version} dibuat dan tersimpan otomatis.`, ephemeral: true });
        collector.stop('opened');
        await panel.edit({ content: `Editor revisi dibuka untuk ${lawDisplayName(draft)}, mulai dari Pasal ${articleNumber}.`, embeds: [], components: [] });
        await draftPanel(msg, draft, { initialArticleNumber: articleNumber });
      } catch (error) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: `Gagal membuka revisi: ${error.message}`, ephemeral: true }).catch(() => null);
        } else {
          await interaction.reply({ content: `Gagal membuka revisi: ${error.message}`, ephemeral: true }).catch(() => null);
        }
      }
    });
    collector.on('end', (_, reason) => {
      if (!['opened', 'cancelled'].includes(reason)) void panel.edit(payload(true)).catch(() => null);
    });
  }

  async function draftPanel(msg, initialLaw, { initialArticleNumber = 0 } = {}) {
    const session = crypto.randomBytes(4).toString('hex');
    const actor = actorFrom(msg);
    let law = initialLaw;
    let draftArticlePage = initialArticleNumber
      ? Math.max(0, law.articles.findIndex(article => article.number === Number(initialArticleNumber)))
      : Math.max(0, law.articles.length - 1);
    let busy = false;

    function isRevision() {
      return Number(law.baseVersion || 0) > 0;
    }

    function payload(disabled = false) {
      const maxArticle = Math.max(0, law.articles.length - 1);
      draftArticlePage = Math.max(0, Math.min(draftArticlePage, maxArticle));
      const embed = detailEmbed(law, draftArticlePage, { draft: true });
      embed.setDescription(compact([
        embed.data.description,
        '',
        isRevision()
          ? '> Ini salinan draft. Versi publik tetap berlaku sampai **Terbitkan Revisi** dikonfirmasi.'
          : '> Nomor resmi baru diberikan saat tombol **Terbitkan UU** dikonfirmasi.',
        '> Setiap perubahan disimpan otomatis ke SQLite dan cadangan JSON.',
      ].join('\n'), 4000));
      const editRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`uud_ayat_${session}`).setLabel('Tambah Ayat').setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`uud_editayat_${session}`).setLabel('Ubah Ayat').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`uud_toggleayat_${session}`).setLabel('Cabut/Pulihkan').setStyle(ButtonStyle.Danger).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`uud_pasal_${session}`).setLabel('Tambah Pasal').setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`uud_heading_${session}`).setLabel('Judul Pasal').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
      );
      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`uud_prev_${session}`).setLabel('Pasal Sebelumnya').setStyle(ButtonStyle.Secondary).setDisabled(disabled || draftArticlePage <= 0),
        new ButtonBuilder().setCustomId(`uud_next_${session}`).setLabel('Pasal Berikutnya').setStyle(ButtonStyle.Secondary).setDisabled(disabled || draftArticlePage >= maxArticle),
        new ButtonBuilder().setCustomId(`uud_title_${session}`).setLabel('Judul UU').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`uud_diff_${session}`).setLabel(isRevision() ? 'Lihat Perubahan' : 'Preview').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`uud_publish_${session}`).setLabel(isRevision() ? 'Terbitkan Revisi' : 'Terbitkan UU').setStyle(ButtonStyle.Success).setDisabled(disabled)
      );
      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`uud_close_${session}`).setLabel('Tutup Editor (Autosave)').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`uud_cancel_${session}`).setLabel(isRevision() ? 'Batalkan Revisi' : 'Batalkan Draft').setStyle(ButtonStyle.Danger).setDisabled(disabled)
      );
      return { embeds: [embed], components: [editRow, actionRow, closeRow] };
    }

    const panel = await msg.reply({ ...payload(), allowedMentions: { repliedUser: false } });
    const collector = panel.createMessageComponentCollector({ time: DRAFT_COLLECTOR_MS });
    collector.on('collect', async interaction => {
      if (interaction.user.id !== msg.author.id) {
        await interaction.reply({ content: 'Panel draft ini hanya bisa dikendalikan oleh admin yang membukanya.', ephemeral: true });
        return;
      }
      if (busy) {
        await interaction.reply({ content: 'Editor sedang menyimpan perubahan sebelumnya. Tunggu sebentar.', ephemeral: true }).catch(() => null);
        return;
      }
      busy = true;
      let responder = interaction;
      try {
        if (interaction.customId === `uud_diff_${session}`) {
          const description = isRevision()
            ? revisionDiffText(database.lawRevisionDiff(law.id, law.version))
            : 'Periksa setiap Pasal dengan tombol navigasi. Draft awal belum memiliki versi pembanding.';
          await interaction.reply({
            embeds: [new EmbedBuilder()
              .setColor(0x9b51e0)
              .setTitle(isRevision() ? 'Perbandingan Draft Revisi' : 'Preview Draft UU')
              .setDescription(description)],
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
          responder = submit;
          law = database.updateLawDraftTitle(law.id, submit.fields.getTextInputValue('title'), actor);
          await submit.reply({ content: 'Judul draft berhasil diperbarui.', ephemeral: true });
        } else if (interaction.customId === `uud_ayat_${session}`) {
          const submit = await askModal(interaction, { id: 'uu_ayat', title: 'Tambah Ayat', fields: [{ id: 'content', label: 'Isi Ayat Baru', placeholder: 'Tuliskan satu ketentuan yang jelas...', maxLength: 1800 }] });
          if (!submit) return;
          responder = submit;
          const targetArticle = law.articles[draftArticlePage]?.number;
          law = database.addLawParagraph(law.id, submit.fields.getTextInputValue('content'), actor, targetArticle);
          await submit.reply({ content: `Ayat baru ditambahkan ke Pasal ${targetArticle || 1}.`, ephemeral: true });
        } else if (interaction.customId === `uud_editayat_${session}`) {
          const targetArticle = law.articles[draftArticlePage]?.number;
          const submit = await askModal(interaction, { id: 'uu_editayat', title: `Ubah Ayat Pasal ${targetArticle}`, fields: [
            { id: 'number', label: 'Nomor Ayat', style: TextInputStyle.Short, placeholder: 'Contoh: 2', maxLength: 6 },
            { id: 'content', label: 'Isi Ayat Baru', placeholder: 'Tuliskan isi pengganti...', maxLength: 1800 },
            { id: 'reason', label: 'Alasan Perubahan', placeholder: 'Mengapa Ayat ini perlu diubah?', maxLength: 500 },
          ] });
          if (!submit) return;
          responder = submit;
          const paragraphNumber = Number(submit.fields.getTextInputValue('number'));
          law = database.updateLawParagraph(
            law.id,
            targetArticle,
            paragraphNumber,
            submit.fields.getTextInputValue('content'),
            submit.fields.getTextInputValue('reason'),
            actor
          );
          await submit.reply({ content: `Pasal ${targetArticle} Ayat (${paragraphNumber}) diperbarui pada draft.`, ephemeral: true });
        } else if (interaction.customId === `uud_toggleayat_${session}`) {
          const targetArticle = law.articles[draftArticlePage]?.number;
          const submit = await askModal(interaction, { id: 'uu_toggleayat', title: `Cabut/Pulihkan Ayat Pasal ${targetArticle}`, fields: [
            { id: 'number', label: 'Nomor Ayat', style: TextInputStyle.Short, placeholder: 'Contoh: 2', maxLength: 6 },
            { id: 'action', label: 'Ketik CABUT atau PULIHKAN', style: TextInputStyle.Short, maxLength: 12 },
            { id: 'reason', label: 'Alasan Tindakan', placeholder: 'Alasan pencabutan atau pemulihan...', maxLength: 500 },
          ] });
          if (!submit) return;
          responder = submit;
          const paragraphNumber = Number(submit.fields.getTextInputValue('number'));
          const action = submit.fields.getTextInputValue('action').trim().toUpperCase();
          if (!['CABUT', 'PULIHKAN'].includes(action)) {
            await submit.reply({ content: 'Aksi tidak valid. Ketik `CABUT` atau `PULIHKAN`.', ephemeral: true });
            return;
          }
          law = database.setLawParagraphRepealed(law.id, targetArticle, paragraphNumber, {
            repealed: action === 'CABUT',
            reason: submit.fields.getTextInputValue('reason'),
          }, actor);
          await submit.reply({ content: `Pasal ${targetArticle} Ayat (${paragraphNumber}) ${action === 'CABUT' ? 'ditandai dicabut' : 'dipulihkan'} pada draft.`, ephemeral: true });
        } else if (interaction.customId === `uud_pasal_${session}`) {
          const submit = await askModal(interaction, { id: 'uu_pasal', title: 'Tambah Pasal', fields: [
            { id: 'heading', label: 'Nama/Topik Pasal (opsional)', style: TextInputStyle.Short, required: false, maxLength: 120 },
            { id: 'content', label: 'Isi Ayat (1)', placeholder: 'Ketentuan pertama dalam Pasal baru...', maxLength: 1800 },
          ] });
          if (!submit) return;
          responder = submit;
          law = database.addLawArticle(law.id, { heading: submit.fields.getTextInputValue('heading'), content: submit.fields.getTextInputValue('content') }, actor);
          draftArticlePage = Math.max(0, law.articles.length - 1);
          await submit.reply({ content: `Pasal ${law.articles.at(-1)?.number} berhasil ditambahkan.`, ephemeral: true });
        } else if (interaction.customId === `uud_heading_${session}`) {
          const targetArticle = law.articles[draftArticlePage]?.number;
          const submit = await askModal(interaction, { id: 'uu_heading', title: `Ubah Judul Pasal ${targetArticle}`, fields: [
            { id: 'heading', label: 'Judul/Topik Pasal', style: TextInputStyle.Short, value: law.articles[draftArticlePage]?.heading || '', required: false, maxLength: 120 },
          ] });
          if (!submit) return;
          responder = submit;
          law = database.updateLawArticleHeading(law.id, targetArticle, submit.fields.getTextInputValue('heading'), actor);
          await submit.reply({ content: `Judul Pasal ${targetArticle} diperbarui.`, ephemeral: true });
        } else if (interaction.customId === `uud_publish_${session}`) {
          const confirmation = isRevision() ? 'TERBITKAN REVISI' : 'TERBITKAN';
          const submit = await askModal(interaction, { id: 'uu_publish', title: 'Konfirmasi Penerbitan', fields: [{ id: 'confirm', label: `Ketik ${confirmation}`, style: TextInputStyle.Short, maxLength: 24 }] });
          if (!submit) return;
          responder = submit;
          if (submit.fields.getTextInputValue('confirm').trim().toUpperCase() !== confirmation) {
            await submit.reply({ content: 'Konfirmasi salah. Draft tidak diterbitkan.', ephemeral: true });
            return;
          }
          await submit.deferReply({ ephemeral: true });
          await database.createBackup({ reason: isRevision() ? 'before-law-revision-publish' : 'before-law-publish' });
          law = isRevision()
            ? database.publishLawRevisionDraft(law.id, actor)
            : database.publishLaw(law.id, actor);
          collector.stop('published');
          await submit.editReply({ content: `✅ ${lawDisplayName(law)} ${isRevision() ? `versi ${law.version}` : ''} berhasil diterbitkan.` });
          await panel.edit({ embeds: [detailEmbed(law, 0)], components: [] });
          if (Number(law.version) > 1) await serverStatusNotifier?.notifyLawRevised?.(law, actor.name);
          else await serverStatusNotifier?.notifyLawPublished?.(law, actor.name);
          return;
        } else if (interaction.customId === `uud_cancel_${session}`) {
          const revisionDraft = isRevision();
          const confirmation = revisionDraft ? 'BATALKAN REVISI' : 'BATALKAN';
          const submit = await askModal(interaction, { id: 'uu_cancel', title: revisionDraft ? 'Batalkan Revisi' : 'Batalkan Draft', fields: [{ id: 'confirm', label: `Ketik ${confirmation}`, style: TextInputStyle.Short, maxLength: 20 }] });
          if (!submit) return;
          responder = submit;
          if (submit.fields.getTextInputValue('confirm').trim().toUpperCase() !== confirmation) {
            await submit.reply({ content: 'Konfirmasi salah. Draft tetap tersimpan.', ephemeral: true });
            return;
          }
          law = revisionDraft
            ? database.discardLawRevisionDraft(law.id, actor)
            : database.archiveLawDraft(law.id, actor);
          collector.stop('archived');
          await submit.reply({ content: revisionDraft ? 'Draft revisi dibatalkan. Versi publik tidak berubah.' : 'Draft dibatalkan dan dipindahkan ke arsip audit.', ephemeral: true });
          await panel.edit({ embeds: [detailEmbed(law, 0, { draft: !revisionDraft })], components: [] });
          return;
        } else if (interaction.customId === `uud_close_${session}`) {
          collector.stop('closed');
          await interaction.update({ ...payload(true), content: 'Editor ditutup. Semua perubahan sudah tersimpan; buka lagi dengan `!edit-uu <kode/ID>`.' });
          return;
        }
        await panel.edit(payload());
      } catch (error) {
        console.error('Law draft interaction failed:', error);
        if (responder.deferred) await responder.editReply({ content: `Gagal memproses draft: ${error.message}` }).catch(() => null);
        else if (responder.replied) await responder.followUp({ content: `Gagal memproses draft: ${error.message}`, ephemeral: true }).catch(() => null);
        else await responder.reply({ content: `Gagal memproses draft: ${error.message}`, ephemeral: true }).catch(() => null);
      } finally {
        busy = false;
      }
    });
    collector.on('end', (_, reason) => {
      if (!['published', 'archived', 'closed'].includes(reason)) void panel.edit(payload(true)).catch(() => null);
    });
  }

  async function confirmLawRevocation(msg, { law, note }) {
    const session = crypto.randomBytes(4).toString('hex');
    const label = 'Cabut UU';
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle(`Konfirmasi ${label}`)
      .setDescription(`**${lawDisplayName(law)} — ${law.title}**`)
      .addFields({ name: 'Alasan Pencabutan', value: compact(note, 1024) })
      .setFooter({ text: 'Hanya admin yang menjalankan command ini yang dapat mengonfirmasi.' });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`uua_yes_${session}`).setLabel(label).setStyle(ButtonStyle.Danger),
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
        const result = database.revokeLaw(law.code || String(law.number), note, actor);
        collector.stop('confirmed');
        await interaction.update({ content: `✅ ${label} berhasil diproses untuk ${lawDisplayName(result)}.`, embeds: [detailEmbed(result, Math.max(0, result.articles.length - 1))], components: [] });
        await serverStatusNotifier?.notifyLawRevoked?.(result, actor.name);
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

    if (/^!(?:uu-help|help-uu|tutorial-uu)$/i.test(raw) || /^!uu\s+(?:help|tutorial|bantuan)$/i.test(raw)) {
      await msg.reply(tutorialPayload());
      return true;
    }

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

    if ((match = raw.match(/^!(?:draft-uu|edit-uu)(?:\s+([\s\S]+))?$/i))) {
      if (!isLawAdmin(msg)) {
        await msg.reply({ content: 'Command ini khusus admin UU.', allowedMentions: { repliedUser: false } });
        return true;
      }
      const requested = String(match[1] || '').trim();
      let full = null;
      if (requested) {
        const initial = /^\d+$/.test(requested)
          ? database.getLaw(requested, { includeDraft: true, byId: true })
          : null;
        full = initial?.status === 'DRAFT' ? initial : database.getLawRevisionDraft(requested);
      } else {
        const initialSummary = database.listLaws({ includeDraft: true, creatorId: msg.author.id, limit: 100 })
          .find(item => item.status === 'DRAFT');
        full = initialSummary
          ? database.getLaw(String(initialSummary.id), { includeDraft: true, byId: true })
          : database.listLawRevisionDrafts({ creatorId: msg.author.id, limit: 100 })[0] || null;
      }
      if (!full || full.revisionStatus !== 'DRAFT') {
        await msg.reply({ content: 'Draft aktif tidak ditemukan. Buat dengan `!create-uu <isi>` atau mulai revisi dengan `!revise-uu`.', allowedMentions: { repliedUser: false } });
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
      const args = parseRevisionArgs(match[1]);
      await revisionStartPanel(msg, args);
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
      await confirmLawRevocation(msg, { law, note: args.note });
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
