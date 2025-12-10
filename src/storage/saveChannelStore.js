const https = require('node:https');
const { AttachmentBuilder } = require('discord.js');

function downloadAttachment(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, res => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download attachment, status ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
      .on('error', reject);
  });
}

function createSaveChannelStore({ channelId, fileName }) {
  let channelCache = null;
  let lastMessageId = null;

  async function resolveChannel(client) {
    if (channelCache) return channelCache;
    channelCache = await client.channels.fetch(channelId);
    return channelCache;
  }

  async function findLatestDataMessage(channel) {
    const messages = await channel.messages.fetch({ limit: 30 });
    return messages.find(
      msg => msg.author?.id === channel.client.user.id &&
        msg.attachments?.some(att => att.name === fileName)
    ) || null;
  }

  async function load(client) {
    try {
      const channel = await resolveChannel(client);
      const latest = await findLatestDataMessage(channel);
      if (!latest) return null;

      lastMessageId = latest.id;
      const attachment = latest.attachments.find(att => att.name === fileName);
      if (!attachment?.url) return null;

      const raw = await downloadAttachment(attachment.url);
      return JSON.parse(raw);
    } catch (err) {
      console.error('Failed to load data from save channel:', err);
      return null;
    }
  }

  async function save(client, data) {
    const channel = await resolveChannel(client);
    const payload = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    const attachment = new AttachmentBuilder(payload, { name: fileName });

    const sent = await channel.send({
      content: 'Data snapshot (auto-save)',
      files: [attachment]
    });

    if (lastMessageId && lastMessageId !== sent.id) {
      try {
        const prev = await channel.messages.fetch(lastMessageId);
        await prev.delete().catch(() => {});
      } catch {
        // ignore deletion issues
      }
    }

    lastMessageId = sent.id;
    return sent;
  }

  return {
    load,
    save
  };
}

module.exports = { createSaveChannelStore };
