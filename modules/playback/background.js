(() => {
  "use strict";
  globalThis.OTTDeckPlaybackBackground = ({
    chrome,
    library,
    translation,
    collection,
    senders,
    router,
    product,
  }) => {
    const tabs = new Map();
    function update(tabId, hasVideo, isPlaying) {
      tabs.set(tabId, { hasVideo, isPlaying });
      const suffix = hasVideo && isPlaying ? "" : "-inactive";
      chrome.action
        .setIcon({
          tabId,
          path: Object.fromEntries(
            [16, 32, 48].map((size) => [
              size,
              `icons/icon-${size}${suffix}.png`,
            ]),
          ),
        })
        .catch(() => {});
      chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
      chrome.action
        .setTitle({
          tabId,
          title: `${product.name} · ${hasVideo ? (isPlaying ? "재생 중" : "일시정지") : "비디오 없음"}`,
        })
        .catch(() => {});
    }
    router.register("updateVideoState", {
      authorize: senders.content,
      reply: false,
      handle: (m, s) => {
        update(s.tab.id, Boolean(m.hasVideo), Boolean(m.isPlaying));
        void translation.observe(s.tab.id, m.mediaKey).catch(() => {});
      },
    });
    router.register("getSubtitleSession", {
      authorize: senders.content,
      accepts: (m) =>
        typeof m.mediaKey === "string" && m.mediaKey.length < 2048,
      handle: async (m) => {
        const session = await library.get(m.mediaKey);
        return {
          session: session
            ? {
                mediaKey: session.mediaKey,
                tracks: session.tracks,
                settings: session.settings,
              }
            : null,
        };
      },
    });
    chrome.tabs.onRemoved.addListener((id) => {
      tabs.delete(id);
      void translation.removed(id).catch(() => {});
      void collection.removed(id).catch(() => {});
    });
    chrome.tabs.onUpdated.addListener((id, change) => {
      if (change.status === "loading") {
        update(id, false, false);
        tabs.delete(id);
      }
      if (change.status === "complete") void collection.tick().catch(() => {});
    });
    chrome.tabs.onActivated.addListener(async ({ tabId }) => {
      void collection.tick().catch(() => {});
      const cached = tabs.get(tabId);
      if (cached) {
        update(tabId, cached.hasVideo, cached.isPlaying);
        return;
      }
      try {
        const state = await chrome.tabs.sendMessage(tabId, {
          action: "checkVideo",
        });
        if (state) update(tabId, state.hasVideo, state.isPlaying);
      } catch {}
    });
  };
})();
