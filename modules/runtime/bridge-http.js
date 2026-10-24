/* One loopback transport for UI pages and background delivery; no DOM access. */
(() => {
  "use strict";
  globalThis.OTTDeckBridgeHttp = ({
    fetch: fetcher = globalThis.fetch,
    timeoutMs = 15000,
    offlineMessage = "로컬 번역 브리지에 연결하지 못했습니다.",
  } = {}) => {
    const config = OTTDeckProduct.bridge;
    return async (path, { body, token } = {}) => {
      if (
        typeof path !== "string" ||
        !/^\/extension\/[a-zA-Z0-9_./-]+$/.test(path) ||
        path.split("/").includes("..")
      )
        throw new Error("Invalid local bridge route.");
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = {
          [config.clientHeader]: config.clientValue,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const response = await fetcher(config.baseUrl + path, {
          method: body === undefined ? "GET" : "POST",
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
          cache: "no-store",
          credentials: "omit",
        });
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error || "브리지 요청에 실패했습니다.");
        return value;
      } catch (error) {
        if (error.name === "AbortError" || error instanceof TypeError)
          throw new Error(offlineMessage);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
  };
})();
