/* Branding changes independently of persisted and externally paired identities. */
((root, factory) => {
  const value = factory();
  if (typeof module === "object" && module.exports) module.exports = value;
  root.OTTDeckProduct = value;
})(globalThis, () =>
  Object.freeze({
    name: "OTTDeck",
    slug: "ottdeck",
    extensionName: "OTTDeck — 자막·번역·시청 도구",
    description: "자막부터 재생까지, 나에게 맞추는 OTT.",
    bridge: Object.freeze({
      baseUrl: "http://127.0.0.1:43127",
      extensionPath: "/extension",
      clientHeader: "X-OTTSpeed-Client",
      clientValue: "workspace",
      pairingClient: "OTTSpeed",
      service: "ottspeed-translation-bridge",
    }),
    compatibility: Object.freeze({
      database: "ottspeed-subtitles",
      databaseVersion: 1,
      sessionStore: "sessions",
      bridgeStorage: "ottspeedBridge",
      translationStorage: "ottspeedTranslation",
      libraryStorage: "ottspeedLibrary",
      nativeHost: "com.ottspeed.runtime",
      windowsTask: "OTTSpeed-Translation-Stack",
    }),
  }),
);
