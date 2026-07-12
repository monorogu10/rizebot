function createMessageHandler({
  linkBlocker,
  keywordReply,
  registerHandler,
  moderationHandler,
  shopHandler,
  socialFinanceHandler,
  companyPanelHandler,
  minecraftBridgeHandler,
  topupHandler
}) {
  return async function handleMessage(msg) {
    if (!msg) return;

    const deleted = await linkBlocker(msg);
    if (deleted) return;

    if (moderationHandler) {
      const handled = await moderationHandler(msg);
      if (handled) return;
    }

    if (shopHandler) {
      const handled = await shopHandler(msg);
      if (handled) return;
    }

    if (socialFinanceHandler) {
      const handled = await socialFinanceHandler(msg);
      if (handled) return;
    }

    if (companyPanelHandler) {
      const handled = await companyPanelHandler(msg);
      if (handled) return;
    }

    if (minecraftBridgeHandler) {
      const handled = await minecraftBridgeHandler(msg);
      if (handled) return;
    }

    if (topupHandler) {
      const handled = await topupHandler(msg);
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
