/* Stable MV3 entry point; domain modules own behavior and authorization. */
importScripts(
  "../shared/product.js",
  "../modules/runtime/bridge-http.js",
  "../subtitles/core.js",
  "../subtitles/netflix.js",
  "../subtitles/capture-validation.js",
  "../subtitles/catalog.js",
  "../subtitles/library.js",
  "../subtitles/translation-prompt.js",
  "../subtitles/bridge-client.js",
  "../subtitles/translation-worker.js",
  "../subtitles/collection-queue.js",
  "../subtitles/runtime-client.js",
  "../modules/library/mcp-registration.js",
  "../modules/app/senders.js",
  "../modules/app/message-router.js",
  "../modules/runtime/background.js",
  "../modules/translation/background.js",
  "../modules/capture/background.js",
  "../modules/playback/background.js",
  "../modules/app/background.js",
);
OTTDeckBackground({ chrome });
