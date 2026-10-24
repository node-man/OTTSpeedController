(() => {
  "use strict";
  globalThis.OTTDeckRuntimeBackground = ({ runtime, router, senders }) => {
    router.register("ensureLocalRuntime", {
      authorize: senders.management,
      handle: () => runtime.ensure(),
    });
    router.register("getLocalRuntimeStatus", {
      authorize: senders.management,
      handle: () => runtime.status(),
    });
  };
})();
