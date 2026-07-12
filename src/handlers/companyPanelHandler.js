const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const PANEL_COLLECTOR_MS = 5 * 60 * 1000;
const MODAL_TIMEOUT_MS = 2 * 60 * 1000;
const PANEL_PREFIX = 'companypanel';

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatNumber(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function isApprovedRegisterEntry(entry) {
  const status = String(entry?.status || '').toLowerCase();
  return Boolean(entry?.legal === true || status === 'approved');
}

function noPing(payload) {
  return {
    ...payload,
    allowedMentions: payload.allowedMentions || { parse: [], repliedUser: false },
  };
}

function panelActionId(sessionId, action) {
  return `${PANEL_PREFIX}:${sessionId}:${action}`;
}

function resultReason(result) {
  const messages = Array.isArray(result?.messages) ? result.messages.filter(Boolean) : [];
  if (messages.length) return messages[messages.length - 1];
  const code = String(result?.code || 'unknown');
  const known = {
    'bridge-result-timeout': 'Minecraft tidak merespons sebelum batas waktu. Pastikan world dan behavior pack aktif.',
    'company-actor-not-legal': 'Gamertag kamu belum tercatat legal di behavior pack.',
    'discord-actor-not-legal': 'Gamertag kamu belum tercatat legal di behavior pack.',
    'company-discord-link-mismatch': 'Gamertag legal tersebut terhubung ke akun Discord lain.',
    'discord-link-mismatch': 'Gamertag legal tersebut terhubung ke akun Discord lain.',
    'company-organization-not-found': 'Gamertag kamu belum menjadi anggota organisasi.',
    'organization-not-company': 'Organisasi kamu belum menjadi perusahaan.',
    'company-operation-rejected': 'Perubahan ditolak oleh permission atau validasi perusahaan Minecraft.',
  };
  return known[code] || `Operasi gagal: ${code}.`;
}

function companyPermissions(snapshot) {
  const overview = snapshot?.overview || {};
  return {
    structure: Boolean(overview.canManageCompanyStructure),
    finance: Boolean(overview.canManageCompanyFinance),
    powerRoles: Boolean(overview.canManageCompanyPowerRoles),
  };
}

function findDivision(snapshot, divisionId) {
  const divisions = Array.isArray(snapshot?.divisions) ? snapshot.divisions : [];
  return divisions.find(entry => String(entry?.id || '') === String(divisionId || '')) ||
    divisions.find(entry => entry?.isDefault) ||
    divisions[0] || null;
}

function normalizeSessionSelection(session, snapshot) {
  const selected = findDivision(snapshot, session.selectedDivisionId);
  session.selectedDivisionId = selected?.id || '';

  const divisions = Array.isArray(snapshot?.divisions) ? snapshot.divisions : [];
  const validTarget = divisions.find(entry =>
    entry.id === session.targetDivisionId && entry.id !== session.selectedDivisionId
  );
  const fallbackTarget = divisions.find(entry => entry.isDefault && entry.id !== session.selectedDivisionId) ||
    divisions.find(entry => entry.id !== session.selectedDivisionId) ||
    null;
  session.targetDivisionId = validTarget?.id || fallbackTarget?.id || '';
}

function buildPanelEmbed(snapshot, session, disabled = false) {
  const overview = snapshot?.overview || {};
  const permissions = companyPermissions(snapshot);
  const selected = findDivision(snapshot, session.selectedDivisionId);
  const target = findDivision(snapshot, session.targetDivisionId);
  const members = Array.isArray(snapshot?.members) ? snapshot.members : [];
  const permissionLabels = [
    permissions.structure ? 'Struktur' : '',
    permissions.finance ? 'Finance' : '',
    permissions.powerRoles ? 'Hirarki' : '',
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(disabled ? 0x95a5a6 : 0x2f80ed)
    .setTitle(`${overview.companyTicker || 'Company'} — Company Control`)
    .setDescription(
      disabled
        ? 'Sesi panel sudah berakhir. Jalankan `!perusahaan` untuk membuka panel baru.'
        : 'Data dan permission selalu divalidasi ulang oleh behavior pack Minecraft.'
    )
    .addFields(
      {
        name: 'Perusahaan',
        value: [
          `Organisasi: **${overview.orgName || '-'}**`,
          `Kas: **${formatNumber(overview.cashGeon)} Geon**`,
          `Member: **${formatNumber(members.length)}**`,
          `Divisi: **${formatNumber(snapshot?.divisions?.length)}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Akses Kamu',
        value: [
          overview.companyPowerRoleLabel || '-',
          permissionLabels.length ? permissionLabels.join(', ') : 'Lihat saja',
        ].join('\n'),
        inline: true,
      }
    );

  if (selected) {
    embed.addFields({
      name: `Divisi: ${selected.name}`,
      value: [
        `ID: \`${selected.id}\``,
        `Gaji: **${formatNumber(selected.salaryGeon)} Geon** / payroll`,
        `Member: **${formatNumber(selected.memberCount)}**`,
        `Manager: **${selected.managerName || '-'}**`,
        selected.isDefault ? 'Divisi utama: tidak dapat diganti nama atau dihapus.' :
          `Jika dihapus, member dipindahkan ke **${target?.name || '-'}**.`,
      ].join('\n'),
      inline: false,
    });
  }

  return embed.setFooter({ text: `Gamertag: ${session.gamertag} • Perubahan dicatat di transparency log` });
}

function buildPanelRows(snapshot, session, disabled = false) {
  const divisions = Array.isArray(snapshot?.divisions) ? snapshot.divisions : [];
  if (!divisions.length) return [];
  const selected = findDivision(snapshot, session.selectedDivisionId);
  const permissions = companyPermissions(snapshot);
  const rows = [];

  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(panelActionId(session.id, 'division'))
      .setPlaceholder('Pilih divisi yang dikelola')
      .setDisabled(disabled)
      .addOptions(divisions.slice(0, 25).map(entry => ({
        label: String(entry.name || entry.id).slice(0, 100),
        description: `${formatNumber(entry.memberCount)} member • ${formatNumber(entry.salaryGeon)} Geon`.slice(0, 100),
        value: String(entry.id),
        default: entry.id === selected?.id,
      })))
  ));

  const targets = divisions.filter(entry => entry.id !== selected?.id);
  if (targets.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(panelActionId(session.id, 'target'))
        .setPlaceholder('Tujuan member jika divisi dihapus')
        .setDisabled(disabled || selected?.isDefault || !permissions.structure)
        .addOptions(targets.slice(0, 25).map(entry => ({
          label: String(entry.name || entry.id).slice(0, 100),
          description: entry.isDefault ? 'Divisi utama (disarankan)' : `${formatNumber(entry.memberCount)} member`,
          value: String(entry.id),
          default: entry.id === session.targetDivisionId,
        })))
    ));
  }

  const canEdit = Boolean(
    selected && (permissions.finance || (permissions.structure && !selected.isDefault))
  );
  const canDelete = Boolean(selected && permissions.structure && !selected.isDefault && targets.length);
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(panelActionId(session.id, 'create'))
      .setLabel('Tambah Divisi')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled || !permissions.structure),
    new ButtonBuilder()
      .setCustomId(panelActionId(session.id, 'edit'))
      .setLabel('Edit')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled || !canEdit),
    new ButtonBuilder()
      .setCustomId(panelActionId(session.id, 'delete'))
      .setLabel('Hapus')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled || !canDelete),
    new ButtonBuilder()
      .setCustomId(panelActionId(session.id, 'refresh'))
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  ));

  return rows;
}

function createTextInput(customId, label, value, required = true) {
  return new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label.slice(0, 45))
    .setStyle(TextInputStyle.Short)
    .setRequired(required)
    .setValue(String(value ?? '').slice(0, 4000));
}

async function runCompanyJob(bridge, session, operation, payload = {}) {
  const pending = bridge.enqueueBridgeQueryWithResult('company_panel', {
    operation,
    actorKey: session.gamertag,
    actorDiscordUserId: session.userId,
    requestedBy: session.userId,
    ...payload,
  });
  return pending.result;
}

async function showOperationResult(interaction, result, successTitle) {
  const ok = Boolean(result?.ok);
  await interaction.editReply(noPing({
    embeds: [
      new EmbedBuilder()
        .setColor(ok ? 0x2ecc71 : 0xe74c3c)
        .setTitle(ok ? successTitle : 'Perubahan Ditolak')
        .setDescription(resultReason(result))
        .setFooter({ text: `Ref ${result?.jobId || '-'}` })
        .setTimestamp(),
    ],
  })).catch(() => {});
}

function createCompanyPanelHandler({ bridge, registerStore }) {
  return async function handleCompanyPanel(msg) {
    if (!msg || msg.author?.bot) return false;
    if (!/^!(?:perusahaan|company|company-panel)\s*$/i.test(normalizeSpaces(msg.content))) return false;

    const entry = registerStore.getUser(msg.author.id);
    if (!isApprovedRegisterEntry(entry) || !entry?.gamertag) {
      await msg.reply(noPing({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('Company Control Terkunci')
            .setDescription('Akun Discord kamu harus approved/legal dan memiliki gamertag Minecraft.'),
        ],
      })).catch(() => {});
      return true;
    }

    if (typeof bridge.enqueueBridgeQueryWithResult !== 'function') {
      await msg.reply('Company Control belum tersedia pada bridge ini.').catch(() => {});
      return true;
    }

    const session = {
      id: crypto.randomBytes(5).toString('hex'),
      userId: String(msg.author.id),
      gamertag: normalizeSpaces(entry.gamertag),
      selectedDivisionId: '',
      targetDivisionId: '',
    };

    const loading = await msg.reply(noPing({
      embeds: [
        new EmbedBuilder()
          .setColor(0xf2c94c)
          .setTitle('Membuka Company Control')
          .setDescription(`Memvalidasi \`${session.gamertag}\` dan mengambil data perusahaan dari Minecraft...`),
      ],
    })).catch(() => null);
    if (!loading) return true;

    let snapshot = await runCompanyJob(bridge, session, 'snapshot');
    if (!snapshot?.ok) {
      await loading.edit(noPing({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('Company Control Tidak Tersedia')
            .setDescription(resultReason(snapshot))
            .setFooter({ text: `Ref ${snapshot?.jobId || '-'}` }),
        ],
        components: [],
      })).catch(() => {});
      return true;
    }

    normalizeSessionSelection(session, snapshot);
    await loading.edit(noPing({
      embeds: [buildPanelEmbed(snapshot, session)],
      components: buildPanelRows(snapshot, session),
    })).catch(() => {});

    const collector = loading.createMessageComponentCollector({
      time: PANEL_COLLECTOR_MS,
      filter: interaction => String(interaction.customId || '').startsWith(`${PANEL_PREFIX}:${session.id}:`),
    });

    async function refreshPanel() {
      normalizeSessionSelection(session, snapshot);
      await loading.edit(noPing({
        embeds: [buildPanelEmbed(snapshot, session)],
        components: buildPanelRows(snapshot, session),
      })).catch(() => {});
    }

    collector.on('collect', async interaction => {
      if (String(interaction.user?.id || '') !== session.userId) {
        await interaction.reply(noPing({
          content: 'Panel ini hanya dapat dipakai oleh user yang membukanya.',
          ephemeral: true,
        })).catch(() => {});
        return;
      }

      const action = String(interaction.customId || '').split(':')[2] || '';
      if (action === 'division') {
        session.selectedDivisionId = interaction.values?.[0] || '';
        normalizeSessionSelection(session, snapshot);
        await interaction.update(noPing({
          embeds: [buildPanelEmbed(snapshot, session)],
          components: buildPanelRows(snapshot, session),
        })).catch(() => {});
        return;
      }
      if (action === 'target') {
        session.targetDivisionId = interaction.values?.[0] || '';
        await interaction.update(noPing({
          embeds: [buildPanelEmbed(snapshot, session)],
          components: buildPanelRows(snapshot, session),
        })).catch(() => {});
        return;
      }
      if (action === 'refresh') {
        await interaction.deferUpdate().catch(() => {});
        const refreshed = await runCompanyJob(bridge, session, 'snapshot');
        if (refreshed?.ok) snapshot = refreshed;
        normalizeSessionSelection(session, snapshot);
        await refreshPanel();
        if (!refreshed?.ok) {
          await interaction.followUp(noPing({ content: resultReason(refreshed), ephemeral: true })).catch(() => {});
        }
        return;
      }

      const permissions = companyPermissions(snapshot);
      const selected = findDivision(snapshot, session.selectedDivisionId);
      let modal;
      if (action === 'create') {
        if (!permissions.structure) return;
        modal = new ModalBuilder()
          .setCustomId(panelActionId(session.id, 'create-submit'))
          .setTitle('Tambah Divisi Perusahaan')
          .addComponents(new ActionRowBuilder().addComponents(createTextInput('name', 'Nama divisi', '')));
        if (permissions.finance) {
          modal.addComponents(new ActionRowBuilder().addComponents(createTextInput('salary', 'Gaji per payroll', '0')));
        }
      } else if (action === 'edit') {
        if (!selected) return;
        const canEditName = permissions.structure && !selected.isDefault;
        if (!canEditName && !permissions.finance) return;
        modal = new ModalBuilder()
          .setCustomId(panelActionId(session.id, 'edit-submit'))
          .setTitle(`Edit ${String(selected.name).slice(0, 38)}`);
        if (canEditName) {
          modal.addComponents(new ActionRowBuilder().addComponents(createTextInput('name', 'Nama divisi', selected.name)));
        }
        if (permissions.finance) {
          modal.addComponents(new ActionRowBuilder().addComponents(
            createTextInput('salary', 'Gaji per payroll', selected.salaryGeon)
          ));
        }
      } else if (action === 'delete') {
        if (!selected || selected.isDefault || !permissions.structure || !session.targetDivisionId) return;
        modal = new ModalBuilder()
          .setCustomId(panelActionId(session.id, 'delete-submit'))
          .setTitle(`Hapus ${String(selected.name).slice(0, 37)}`)
          .addComponents(new ActionRowBuilder().addComponents(
            createTextInput('confirmation', `Ketik ${selected.name} untuk konfirmasi`, '')
          ));
      } else {
        return;
      }

      await interaction.showModal(modal).catch(() => {});
      let submitted;
      try {
        submitted = await interaction.awaitModalSubmit({
          time: MODAL_TIMEOUT_MS,
          filter: modalInteraction =>
            modalInteraction.user?.id === session.userId &&
            String(modalInteraction.customId || '').startsWith(`${PANEL_PREFIX}:${session.id}:`),
        });
      } catch {
        return;
      }
      await submitted.deferReply({ ephemeral: true }).catch(() => {});

      let result;
      let successTitle;
      if (action === 'create') {
        result = await runCompanyJob(bridge, session, 'create_division', {
          name: submitted.fields.getTextInputValue('name'),
          salaryGeon: permissions.finance ? submitted.fields.getTextInputValue('salary') : 0,
        });
        successTitle = 'Divisi Dibuat';
      } else if (action === 'edit') {
        const canEditName = permissions.structure && !selected.isDefault;
        result = await runCompanyJob(bridge, session, 'update_division', {
          divisionId: selected.id,
          name: canEditName ? submitted.fields.getTextInputValue('name') : selected.name,
          salaryGeon: permissions.finance
            ? submitted.fields.getTextInputValue('salary')
            : selected.salaryGeon,
        });
        successTitle = 'Divisi Diperbarui';
      } else {
        result = await runCompanyJob(bridge, session, 'delete_division', {
          divisionId: selected.id,
          targetDivisionId: session.targetDivisionId,
          confirmation: submitted.fields.getTextInputValue('confirmation'),
        });
        successTitle = 'Divisi Dihapus';
      }

      if (result?.overview && Array.isArray(result?.divisions)) snapshot = result;
      normalizeSessionSelection(session, snapshot);
      await refreshPanel();
      await showOperationResult(submitted, result, successTitle);
    });

    collector.on('end', async () => {
      await loading.edit(noPing({
        embeds: [buildPanelEmbed(snapshot, session, true)],
        components: buildPanelRows(snapshot, session, true),
      })).catch(() => {});
    });

    return true;
  };
}

module.exports = { createCompanyPanelHandler };
