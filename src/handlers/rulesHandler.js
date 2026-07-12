const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

const PAGE_SIZE = 8;
const COLLECTOR_MS = 5 * 60 * 1000;

function titleCaseTypeId(value) {
  const raw = String(value || '').trim();
  const [namespace, ...rest] = raw.split(':');
  const id = rest.length ? rest.join(':') : namespace;
  const label = id.replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  return { label: label || raw || 'Unknown', id: raw || '-' };
}

function uniqueSorted(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function createRulesHandler({ bridge, database }) {
  if (!bridge || !database) throw new Error('Rules handler requires bridge and database');

  async function loadRules() {
    try {
      const pending = bridge.enqueueBridgeQueryWithResult('rules_snapshot', {}, { timeoutMs: 15_000 });
      const live = await pending.result;
      if (live?.ok) {
        database.saveRulesCache(live, { source: 'minecraft-live' });
        return { rules: live, live: true };
      }
    } catch (error) {
      console.warn('Live rules snapshot gagal, mencoba cache:', error?.message || error);
    }
    const cached = database.getRulesCache();
    return cached ? { rules: cached.payload, live: false, cachedAt: cached.fetchedAt } : null;
  }

  return async function handleRules(msg) {
    if (!msg || msg.author?.bot || !/^!rules\s*$/i.test(String(msg.content || '').trim())) return false;
    const loading = await msg.reply({ content: 'Mengambil peraturan item terbaru dari Ethergeon...', allowedMentions: { repliedUser: false } });
    const loaded = await loadRules();
    if (!loaded) {
      await loading.edit({
        content: 'Data rules belum tersedia. Minecraft sedang offline dan belum ada cache rules sebelumnya.',
        embeds: [],
        components: [],
      });
      return true;
    }

    const rules = loaded.rules;
    const policies = rules.policies || {};
    const categories = {
      banned: {
        label: 'Item Banned Manual',
        emoji: '🚫',
        description: 'Item yang ditetapkan langsung oleh The Elite/King dan tidak boleh dipegang.',
        items: uniqueSorted(rules.bannedItems),
      },
      dangerous: {
        label: 'Item Berbahaya',
        emoji: '⚠️',
        description: policies.dangerousTemplateEnabled
          ? 'Template proteksi item berbahaya sedang aktif di server.'
          : 'Template proteksi item berbahaya sedang tidak aktif.',
        items: uniqueSorted(rules.dangerousItems),
      },
      entities: {
        label: 'Entity Dilarang',
        emoji: '🛑',
        description: 'Entity yang diblokir oleh sistem keamanan Ethergeon.',
        items: uniqueSorted(rules.bannedEntities),
      },
      policy: {
        label: 'Kebijakan Entity',
        emoji: '🛡️',
        description: policies.entitySummonLockEnabled
          ? 'Entity summon lock aktif. Daftar berikut adalah entity yang tetap diizinkan.'
          : 'Entity summon lock sedang tidak aktif. Daftar berikut adalah allowlist tersimpan.',
        items: uniqueSorted(rules.entityAllowlist),
      },
    };
    const session = crypto.randomBytes(4).toString('hex');
    let categoryKey = 'banned';
    let page = 0;

    function payload(disabled = false) {
      const category = categories[categoryKey];
      const pageCount = Math.max(1, Math.ceil(category.items.length / PAGE_SIZE));
      page = Math.max(0, Math.min(page, pageCount - 1));
      const start = page * PAGE_SIZE;
      const lines = category.items.slice(start, start + PAGE_SIZE).map((typeId, index) => {
        const item = titleCaseTypeId(typeId);
        return `**${start + index + 1}. ${item.label}**\n\`${item.id}\``;
      });
      const fetchedAt = rules.fetchedAt || loaded.cachedAt;
      const embed = new EmbedBuilder()
        .setColor(loaded.live ? 0xe74c3c : 0xf2c94c)
        .setTitle(`${category.emoji} Rules Ethergeon — ${category.label}`)
        .setDescription([category.description, '', lines.join('\n\n') || '*Tidak ada item pada kategori ini.*'].join('\n'))
        .addFields({
          name: 'Status Data',
          value: loaded.live
            ? '🟢 LIVE — tersambung langsung ke sistem keamanan Minecraft.'
            : '🟡 CACHE — Minecraft sedang tidak merespons; menampilkan data terakhir.',
          inline: false,
        })
        .setFooter({ text: `Halaman ${page + 1}/${pageCount} • ${category.items.length} entri${fetchedAt ? ` • sinkron ${String(fetchedAt).slice(0, 19).replace('T', ' ')}` : ''}` });

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`rules_cat_${session}`)
        .setPlaceholder('Pilih kategori rules')
        .setDisabled(disabled)
        .addOptions(Object.entries(categories).map(([value, entry]) => ({
          label: entry.label,
          value,
          emoji: entry.emoji,
          default: value === categoryKey,
          description: `${entry.items.length} entri`,
        })));
      const nav = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rules_prev_${session}`).setLabel('Sebelumnya').setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || page <= 0),
        new ButtonBuilder().setCustomId(`rules_next_${session}`).setLabel('Berikutnya').setStyle(ButtonStyle.Primary)
          .setDisabled(disabled || page >= pageCount - 1)
      );
      return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), nav] };
    }

    await loading.edit({ content: '', ...payload() });
    const collector = loading.createMessageComponentCollector({ time: COLLECTOR_MS });
    collector.on('collect', async interaction => {
      if (interaction.user.id !== msg.author.id) {
        await interaction.reply({ content: 'Panel ini hanya bisa dikendalikan oleh user yang menjalankan `!rules`.', ephemeral: true });
        return;
      }
      if (interaction.customId === `rules_cat_${session}`) {
        categoryKey = interaction.values[0] || 'banned';
        page = 0;
      } else if (interaction.customId === `rules_prev_${session}`) {
        page -= 1;
      } else if (interaction.customId === `rules_next_${session}`) {
        page += 1;
      }
      await interaction.update(payload());
    });
    collector.on('end', () => void loading.edit(payload(true)).catch(() => null));
    return true;
  };
}

module.exports = { createRulesHandler, titleCaseTypeId };
