function createMessageHandler({ linkBlocker, keywordReply, adminCommands, statusCommand }) {
  return async function handleMessage(msg) {
    if (!msg) return;

    const deleted = await linkBlocker(msg);
    if (deleted) return;

    await keywordReply(msg);
    const handledAdmin = await adminCommands(msg);
    if (handledAdmin) return;

    await statusCommand(msg);
  };
}

module.exports = { createMessageHandler };
