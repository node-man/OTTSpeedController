/* Native execution is accessible only to exact extension management pages. */
(() => {
  "use strict";
  globalThis.OTTDeckSenders = (chrome) => {
    const own = (s) => s?.id === chrome.runtime.id;
    const exact = (s, path) => own(s) && s.url === chrome.runtime.getURL(path);
    const popup = (s) => exact(s, "popup/popup.html") && !s.tab;
    const library = (s) => exact(s, "subtitles/library.html");
    const workspace = (s) => {
      if (!own(s)) return false;
      const base = chrome.runtime.getURL("subtitles/workspace.html");
      return (
        s.url === base ||
        (s.url?.startsWith(base + "?tabId=") &&
          /^\d+$/.test(s.url.slice(base.length + 7)))
      );
    };
    return Object.freeze({
      popup,
      library,
      workspace,
      management: (s) => popup(s) || library(s) || workspace(s),
      content: (s) => own(s) && Number.isInteger(s.tab?.id),
    });
  };
})();
