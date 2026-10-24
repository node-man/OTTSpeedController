/* Composition root: domain modules own behavior and durable stores own data. */
(() => {
  "use strict";
  globalThis.OTTDeckBackground = ({ chrome }) => {
    const router = OTTDeckMessageRouter(),
      senders = OTTDeckSenders(chrome),
      runtime = OTTLocalRuntime({ chrome });
    const translation = OTTTranslationWorker({
      chrome,
      core: OTTSubtitles,
      client: OTTBridgeClient,
      library: OTTSubtitleLibrary,
    });
    const collection = OTTCollectionQueue({
      chrome,
      core: OTTSubtitles,
      validation: OTTCaptureValidation,
      library: OTTSubtitleLibrary,
    });
    OTTDeckRuntimeBackground({ runtime, router, senders });
    OTTDeckTranslationBackground({ worker: translation, router, senders });
    OTTDeckCaptureBackground({ queue: collection, router, senders });
    OTTDeckPlaybackBackground({
      chrome,
      library: OTTSubtitleLibrary,
      translation,
      collection,
      senders,
      router,
      product: OTTDeckProduct,
    });
    chrome.runtime.onMessage.addListener(router.dispatch);
    void translation.initialize().catch(() => {});
    void collection.initialize().catch(() => {});
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === translation.alarm)
        void translation.poll().catch(() => {});
      if (alarm.name === collection.alarm)
        void collection.tick().catch(() => {});
    });
    chrome.runtime.onStartup?.addListener(() => {
      void collection.initialize().catch(() => {});
      void runtime.ensure().catch(() => {});
    });
    chrome.runtime.onInstalled.addListener(({ reason }) => {
      if (reason === "install") void chrome.storage.local.set({ speed: 1 });
    });
    return Object.freeze({ router });
  };
})();
