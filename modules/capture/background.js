(() => {
  "use strict";
  globalThis.OTTDeckCaptureBackground = ({ queue, router, senders }) => {
    const routes = {
      getCollectionQueue: () => queue.status(),
      enqueueCollection: (m) => queue.enqueue(m.urls),
      pauseCollection: () => queue.pause(),
      resumeCollection: () => queue.resume(),
      cancelCollection: (m) => queue.cancel(m.id),
    };
    for (const [action, handle] of Object.entries(routes))
      router.register(action, {
        authorize: senders.library,
        accepts: (m) =>
          action !== "cancelCollection" || typeof m.id === "string",
        handle,
      });
  };
})();
