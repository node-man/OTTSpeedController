(() => {
  "use strict";
  globalThis.OTTDeckTranslationBackground = ({ worker, router, senders }) => {
    router.register("prepareTranslationSource", {
      authorize: senders.popup,
      handle: (m) => worker.prepareSource(m.tabId),
    });
    router.register("watchTranslation", {
      authorize: senders.popup,
      handle: (m) => worker.watch(m.tabId, m.jobId, m.mediaKey),
    });
    router.register("getTranslationExecution", {
      authorize: senders.popup,
      accepts: (m) => /^netflix:\d+$/.test(m.mediaKey || ""),
      handle: (m) => worker.status(m.mediaKey),
    });
    router.register("watchLibraryTranslation", {
      authorize: senders.library,
      handle: (m) =>
        worker.watch(null, m.jobId, m.mediaKey, {
          selectResults: m.selectResults !== false,
        }),
    });
    router.register("refreshLibrarySession", {
      authorize: senders.library,
      accepts: (m) =>
        typeof m.mediaKey === "string" && m.mediaKey.length < 2048,
      handle: (m) => worker.refreshStored(m.mediaKey),
    });
  };
})();
