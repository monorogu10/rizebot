function createMessageHandler({ linkBlocker, keywordReply }) {
  return async function handleMessage(msg) {
    if (!msg) return;

    const deleted = await linkBlocker(msg);
    if (deleted) return;

    await keywordReply(msg);
  };
}

module.exports = { createMessageHandler };
