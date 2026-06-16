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

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createEditableJsonMessageStore({ channelId, fileName }) {
  const marker = `rizebot-json:${fileName}`;
  const markerLine = `<!-- ${marker} -->`;
  let channelCache = null;
  let lastMessageId = null;
  let saveQueue = Promise.resolve();

  async function resolveChannel(client) {
    if (channelCache) return channelCache;
    channelCache = await client.channels.fetch(channelId);
    return channelCache;
  }

  function isDataMessage(message) {
    if (!message || String(message.channelId) !== String(channelId)) return false;
    const content = String(message.content || '');
    if (content.includes(marker)) return true;
    return Boolean(message.attachments?.some(att => att.name === fileName));
  }

  function extractJsonFromContent(content) {
    const rawContent = String(content || '');
    if (!rawContent.trim()) return null;

    const fenceMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/i);
    let rawJson = fenceMatch ? fenceMatch[1].trim() : rawContent.trim();

    rawJson = rawJson
      .replace(new RegExp(escapeRegExp(markerLine), 'g'), '')
      .replace(new RegExp(`^\\*\\*${escapeRegExp(fileName)}\\*\\*`, 'i'), '')
      .trim();

    const start = rawJson.indexOf('{');
    const end = rawJson.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(rawJson.slice(start, end + 1));
  }

  async function parseMessage(message) {
    if (!isDataMessage(message)) return null;

    const contentData = extractJsonFromContent(message.content);
    if (contentData) return contentData;

    const attachment = message.attachments?.find(att => att.name === fileName);
    if (!attachment?.url) return null;
    const raw = await downloadAttachment(attachment.url);
    return JSON.parse(raw);
  }

  async function findLatestDataMessage(channel) {
    const messages = await channel.messages.fetch({ limit: 50 });
    return messages.find(isDataMessage) || null;
  }

  function buildPayload(data) {
    const json = JSON.stringify(data, null, 2);
    const inlineContent = [
      markerLine,
      `**${fileName}**`,
      '```json',
      json,
      '```'
    ].join('\n');

    if (inlineContent.length <= 1900) {
      return {
        content: inlineContent,
        files: [],
        attachments: []
      };
    }

    const attachment = new AttachmentBuilder(Buffer.from(json, 'utf8'), { name: fileName });
    return {
      content: [
        markerLine,
        `**${fileName}**`,
        'JSON terlalu panjang untuk isi chat, jadi disimpan sebagai attachment.'
      ].join('\n'),
      files: [attachment],
      attachments: []
    };
  }

  async function load(client) {
    try {
      const channel = await resolveChannel(client);
      const latest = await findLatestDataMessage(channel);
      if (!latest) return null;

      lastMessageId = latest.id;
      return await parseMessage(latest);
    } catch (err) {
      console.error(`Failed to load ${fileName} from save channel:`, err);
      return null;
    }
  }

  async function loadFromMessage(message) {
    try {
      if (!isDataMessage(message)) return null;
      lastMessageId = message.id;
      return await parseMessage(message);
    } catch (err) {
      console.error(`Failed to parse edited ${fileName}:`, err);
      return null;
    }
  }

  async function performSave(client, data) {
    const channel = await resolveChannel(client);
    const payload = buildPayload(data);
    const sendPayload = {
      content: payload.content,
      files: payload.files
    };

    if (lastMessageId) {
      try {
        const previous = await channel.messages.fetch(lastMessageId);
        if (previous?.author?.id === client.user.id) {
          const edited = await previous.edit(payload);
          lastMessageId = edited.id;
          return edited;
        }
      } catch {
        // Fall through and send a fresh message.
      }
    }

    const sent = await channel.send(sendPayload);
    lastMessageId = sent.id;
    return sent;
  }

  function save(client, data) {
    saveQueue = saveQueue
      .catch(() => null)
      .then(() => performSave(client, data));
    return saveQueue;
  }

  return {
    load,
    loadFromMessage,
    isDataMessage,
    save
  };
}

module.exports = { createEditableJsonMessageStore };
