function createMessageHandler({ linkBlocker, keywordReply, registerHandler, moderationHandler }) {
  return async function handleMessage(msg) {
    if (!msg) return;

    const deleted = await linkBlocker(msg);
    if (deleted) return;

    if (moderationHandler) {
      const handled = await moderationHandler(msg);
      if (handled) return;
    }

    if (registerHandler) {
      const handled = await registerHandler(msg);
      if (handled) return;
    }

    await keywordReply(msg);
  };
}

module.exports = { createMessageHandler };
