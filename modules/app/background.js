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
      onSaved: () => registration.sync({force:true}),
    });
    const registration = OTTDeckMcpRegistration({
      core: OTTSubtitles, catalog: OTTSubtitleCatalog, validation: OTTCaptureValidation,
      library: OTTSubtitleLibrary,
      bridge: async (path, body) => {
        const token = (await chrome.storage.local.get('ottspeedBridge')).ottspeedBridge?.token;
        if (!token) throw new Error('브리지 연결 후 MCP 자동 등록을 재시도합니다.');
        return OTTDeckBridgeHttp()('/extension' + path, {token, body});
      },
      watch: job => translation.watch(null, job.jobId, job.mediaKey, {selectResults:false}),
    });
    const registrationAlarm = 'ottdeck-library-registration';
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
    void registration.sync().catch(() => {});
    void chrome.alarms.create(registrationAlarm, {periodInMinutes:1});
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === registrationAlarm) void registration.sync().catch(() => {});
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
