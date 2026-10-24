import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import product from "../shared/product.js";
import { extensionAssets } from "../shared/extension-assets.mjs";
import * as legacyStore from "../scripts/translation-bridge-store.mjs";
import * as store from "../modules/translation/job-store.mjs";
import { TranslationBatchStore as LegacyBatch } from "../scripts/translation-batch-store.mjs";
import { TranslationBatchStore } from "../modules/translation/batch-store.mjs";
import { SubtitleLibraryArchive as LegacyArchive } from "../scripts/subtitle-library-archive.mjs";
import { SubtitleLibraryArchive } from "../modules/library/archive.mjs";
const sources = await Promise.all(
  [
    "shared/product.js",
    "modules/app/message-router.js",
    "modules/app/senders.js",
    "modules/runtime/bridge-http.js",
  ].map((path) => readFile(new URL("../" + path, import.meta.url), "utf8")),
);
function context(extra = {}) {
  const value = vm.createContext({
    AbortController,
    TypeError,
    setTimeout,
    clearTimeout,
    ...extra,
  });
  for (const source of sources) vm.runInContext(source, value);
  return value;
}

test("OTTDeck keeps existing storage, transport and native identities, and CLI exports refer to the same implementation", () => {
  assert.equal(product.name, "OTTDeck");
  assert(Object.isFrozen(product.compatibility));
  assert.deepEqual(
    { ...product.compatibility },
    {
      database: "ottspeed-subtitles",
      databaseVersion: 1,
      sessionStore: "sessions",
      bridgeStorage: "ottspeedBridge",
      translationStorage: "ottspeedTranslation",
      libraryStorage: "ottspeedLibrary",
      nativeHost: "com.ottspeed.runtime",
      windowsTask: "OTTSpeed-Translation-Stack",
    },
  );
  assert.equal(product.bridge.clientHeader, "X-OTTSpeed-Client");
  assert.equal(product.bridge.pairingClient, "OTTSpeed");
  assert.equal(legacyStore.TranslationStore, store.TranslationStore);
  assert.equal(
    legacyStore.TRANSLATION_INSTRUCTIONS,
    store.TRANSLATION_INSTRUCTIONS,
  );
  assert.equal(LegacyBatch, TranslationBatchStore);
  assert.equal(LegacyArchive, SubtitleLibraryArchive);
});
test("feature router rejects unauthorized calls before validation or execution and preserves async failures", async () => {
  const ctx = context(),
    router = ctx.OTTDeckMessageRouter();
  let inspected = 0,
    executed = 0,
    reply;
  router.register("example", {
    authorize: (s) => s.id === "owner",
    accepts: () => {
      inspected++;
      return true;
    },
    handle: () => {
      executed++;
      throw new Error("visible failure");
    },
  });
  assert.equal(
    router.dispatch({ action: "example" }, { id: "other" }, () => {}),
    false,
  );
  assert.equal(inspected, 0);
  assert.equal(executed, 0);
  assert.throws(
    () =>
      router.register("example", { authorize: () => true, handle: () => {} }),
    /duplicate/,
  );
  assert.equal(
    router.dispatch({ action: "example" }, { id: "owner" }, (value) => {
      reply = value;
    }),
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reply.error, "visible failure");
  assert.equal(executed, 1);
});
test("shared bridge transport fixes destination, keeps authentication and blocks external or traversal routes", async () => {
  const calls = [],
    ctx = context({
      fetch: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ ok: true }) };
      },
    });
  const request = ctx.OTTDeckBridgeHttp();
  await request("/extension/pair", { body: { client: "OTTSpeed" } });
  await request("/extension/jobs", { token: "synthetic-token" });
  assert.equal(calls[0].url, "http://127.0.0.1:43127/extension/pair");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.method, "GET");
  assert.equal(
    calls[1].options.headers.Authorization,
    "Bearer synthetic-token",
  );
  assert.equal(calls[1].options.headers["X-OTTSpeed-Client"], "workspace");
  for (const path of [
    "https://example.test/extension/jobs",
    "/extension/../private",
    "/mcp",
  ])
    await assert.rejects(request(path), /Invalid/);
  assert.equal(calls.length, 2);
});
test("extension build includes browser feature modules and excludes private data and host-side server modules", () => {
  assert(extensionAssets.includes("modules/app/background.js"));
  assert(extensionAssets.includes("modules/runtime/bridge-http.js"));
  assert(!extensionAssets.includes("modules"));
  assert(
    !extensionAssets.some((path) =>
      /private|native\/|bridge-server|job-store|mcp-server/.test(path),
    ),
  );
});
