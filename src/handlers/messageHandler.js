function createMessageHandler({
  linkBlocker,
  keywordReply,
  registerHandler,
  moderationHandler,
  rulesHandler,
  lawHandler,
  shopHandler,
  socialFinanceHandler,
  companyPanelHandler,
  minecraftBridgeHandler,
  topupHandler
}) {
  return async function handleMessage(msg) {
    if (!msg) return false;

    const deleted = msg.fromApplicationCommand ? false : await linkBlocker(msg);
    if (deleted) return true;

    if (moderationHandler) {
      const handled = await moderationHandler(msg);
      if (handled) return true;
    }

    if (rulesHandler) {
      const handled = await rulesHandler(msg);
      if (handled) return true;
    }

    if (lawHandler) {
      const handled = await lawHandler(msg);
      if (handled) return true;
    }

    if (shopHandler) {
      const handled = await shopHandler(msg);
      if (handled) return true;
    }

    if (socialFinanceHandler) {
      const handled = await socialFinanceHandler(msg);
      if (handled) return true;
    }

    if (companyPanelHandler) {
      const handled = await companyPanelHandler(msg);
      if (handled) return true;
    }

    if (minecraftBridgeHandler) {
      const handled = await minecraftBridgeHandler(msg);
      if (handled) return true;
    }

    if (topupHandler) {
      const handled = await topupHandler(msg);
      if (handled) return true;
    }

    if (registerHandler) {
      const handled = await registerHandler(msg);
      if (handled) return true;
    }

    return Boolean(await keywordReply(msg));
  };
}

module.exports = { createMessageHandler };
