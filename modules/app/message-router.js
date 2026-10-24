/* Each feature owns actions; authorization always runs before its handler. */
(() => {
  "use strict";
  globalThis.OTTDeckMessageRouter = () => {
    const routes = new Map();
    function register(
      action,
      { authorize, handle, accepts = () => true, reply = true },
    ) {
      if (
        typeof action !== "string" ||
        routes.has(action) ||
        typeof authorize !== "function" ||
        typeof handle !== "function"
      )
        throw new Error("Invalid or duplicate background action.");
      routes.set(action, { authorize, handle, accepts, reply });
    }
    function dispatch(message, sender, sendResponse) {
      const route = routes.get(message?.action);
      if (!route || !route.authorize(sender) || !route.accepts(message))
        return false;
      if (!route.reply) {
        route.handle(message, sender);
        return false;
      }
      Promise.resolve()
        .then(() => route.handle(message, sender))
        .then(sendResponse)
        .catch((error) => sendResponse({ error: error.message }));
      return true;
    }
    return Object.freeze({ register, dispatch });
  };
})();
