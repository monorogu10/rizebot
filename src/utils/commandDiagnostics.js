function cleanDiagnosticText(value, maxLength = 240) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function diagnosticReference(message) {
  const suffix = String(message?.id || Date.now().toString(36)).slice(-8);
  return `cmd-${Date.now().toString(36)}-${suffix}`;
}

function flattenDiscordValidationErrors(node, path = [], output = []) {
  if (!node || typeof node !== 'object' || output.length >= 3) return output;
  if (Array.isArray(node._errors)) {
    const messages = node._errors
      .map(item => cleanDiagnosticText(item?.message || item?.code, 140))
      .filter(Boolean);
    if (messages.length) output.push(`${path.join('.') || 'payload'}: ${messages.join('; ')}`);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '_errors' || output.length >= 3) continue;
    flattenDiscordValidationErrors(value, [...path, key], output);
  }
  return output;
}

function discordErrorSummary(error) {
  if (!error) return 'Kesalahan internal tanpa detail.';
  const code = cleanDiagnosticText(error.code || error.rawError?.code || '', 40);
  const status = cleanDiagnosticText(error.status || error.httpStatus || '', 20);
  const message = cleanDiagnosticText(
    error.rawError?.message || error.message || error.name || 'Unknown error',
    220
  );
  const labels = [];
  if (code) labels.push(`code ${code}`);
  if (status) labels.push(`HTTP ${status}`);
  const validation = flattenDiscordValidationErrors(error.rawError?.errors || error.errors)
    .join(' | ');
  return [
    `${labels.length ? `${labels.join(', ')}: ` : ''}${message}`,
    validation,
  ].filter(Boolean).join(' | ');
}

function commandLogContext(message, extra = {}) {
  return {
    command: cleanDiagnosticText(extra.command || String(message?.content || '').split(/\s+/g)[0], 80) || '-',
    stage: cleanDiagnosticText(extra.stage, 120) || '-',
    reference: cleanDiagnosticText(extra.reference, 80) || '-',
    messageId: String(message?.id || '-'),
    channelId: String(message?.channelId || message?.channel?.id || '-'),
    guildId: String(message?.guildId || message?.guild?.id || '-'),
    userId: String(message?.author?.id || message?.user?.id || '-'),
    ...extra.details,
  };
}

function logCommandError(scope, message, error, extra = {}) {
  const context = commandLogContext(message, extra);
  console.error(`[command-error][${scope}]`, context, error);
  return context;
}

function logCommandWarning(scope, message, extra = {}) {
  const context = commandLogContext(message, extra);
  console.warn(`[command-warning][${scope}]`, context);
  return context;
}

function logCommandInfo(scope, message, extra = {}) {
  const context = commandLogContext(message, extra);
  console.info(`[command-info][${scope}]`, context);
  return context;
}

function commandErrorPayload({ command, stage, error = null, reason = '', reference }) {
  const detail = cleanDiagnosticText(reason, 240) || discordErrorSummary(error);
  return {
    content: [
      `Command \`${cleanDiagnosticText(command, 80) || 'unknown'}\` tidak dapat diproses.`,
      `Tahap: **${cleanDiagnosticText(stage, 120) || 'unknown'}**`,
      `Penyebab: \`${detail}\``,
      `Ref: \`${cleanDiagnosticText(reference, 80)}\``,
    ].join('\n'),
    allowedMentions: { parse: [], repliedUser: false },
  };
}

async function sendCommandError(message, {
  scope = 'command',
  command = '',
  stage = '',
  error = null,
  reason = '',
  reference = diagnosticReference(message),
  preferChannel = false,
} = {}) {
  const payload = commandErrorPayload({ command, stage, error, reason, reference });
  const attempts = preferChannel
    ? [
        ['channel.send', () => message?.channel?.send?.(payload)],
        ['message.reply', () => message?.reply?.(payload)],
      ]
    : [
        ['message.reply', () => message?.reply?.(payload)],
        ['channel.send', () => message?.channel?.send?.(payload)],
      ];

  for (const [method, send] of attempts) {
    try {
      const sent = await send();
      if (sent) return sent;
    } catch (sendError) {
      logCommandError(scope, message, sendError, {
        command,
        stage: `${stage || 'unknown'} / fallback ${method}`,
        reference,
      });
    }
  }
  return null;
}

async function deliverReplyWithDiagnostics(message, payload, {
  scope = 'command',
  command = '',
  stage = 'mengirim balasan Discord',
  userVisible = true,
} = {}) {
  const reference = diagnosticReference(message);
  try {
    const sent = await message.reply(payload);
    return { ok: true, message: sent, fallbackMessage: null, error: null, reference };
  } catch (error) {
    logCommandError(scope, message, error, { command, stage, reference });
    const fallbackMessage = userVisible
      ? await sendCommandError(message, {
          scope,
          command,
          stage,
          error,
          reference,
          preferChannel: true,
        })
      : null;
    return { ok: false, message: null, fallbackMessage, error, reference };
  }
}

async function replyWithDiagnostics(message, payload, options = {}) {
  const delivery = await deliverReplyWithDiagnostics(message, payload, options);
  return delivery.ok ? delivery.message : null;
}

module.exports = {
  deliverReplyWithDiagnostics,
  diagnosticReference,
  discordErrorSummary,
  logCommandError,
  logCommandInfo,
  logCommandWarning,
  replyWithDiagnostics,
  sendCommandError,
};
