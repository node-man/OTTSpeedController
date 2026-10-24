/* Loopback-only extension API + official MCP Streamable HTTP transport. */
import http from "node:http";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TranslationStore } from "../translation/job-store.mjs";
import { makeMcpServer } from "../translation/mcp-server.mjs";
import { jsonBody, equal } from "./http-policy.mjs";
import {
  WorkspaceAgentLauncher,
  loadWorkspaceAgentSettings,
} from "../../scripts/workspace-agent-launcher.mjs";
import { TranslationBatchStore } from "../translation/batch-store.mjs";
import { SubtitleLibraryArchive } from "../library/archive.mjs";

export async function createBridge({
  directory,
  port = 43127,
  extensionId = "hegbpfhcjpghhhnmnjjedibpfblchefh",
  workspaceAgent,
  libraryArchive,
} = {}) {
  if (!directory || !/^[a-p]{32}$/.test(extensionId))
    throw new Error(
      "Private directory and a valid OTTSpeed extension ID are required.",
    );
  await mkdir(directory, { recursive: true });
  const store = await new TranslationStore(directory).init();
  const batches = await new TranslationBatchStore(store).init();
  const archive =
    libraryArchive ||
    new SubtitleLibraryArchive({ privateRoot: resolve(directory, "..") });
  const launcher = new WorkspaceAgentLauncher(
    directory,
    workspaceAgent || (await loadWorkspaceAgentSettings(directory)),
  );
  const executionFor = async (job) => {
    try {
      return await launcher.status(job);
    } catch {
      return {
        mode: "workspace-agent",
        state: "unavailable",
        errorCode: "execution_record_unavailable",
        translationComplete: job.status === "complete",
      };
    }
  };
  const credentials = join(directory, "extension-credentials.json");
  let token;
  try {
    token = JSON.parse(await readFile(credentials, "utf8")).token;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    token = randomBytes(32).toString("base64url");
    await writeFile(credentials, JSON.stringify({ token }) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  if (typeof token !== "string" || token.length < 40)
    throw new Error("Invalid local pairing credential.");
  const origin = `chrome-extension://${extensionId}`;
  const audit = (event) =>
    appendFile(
      join(directory, "mcp-audit.jsonl"),
      JSON.stringify(event) + "\n",
      { mode: 0o600 },
    );
  const server = http.createServer(async (req, res) => {
    const send = (code, data) => {
      res.writeHead(code, {
        "Content-Type": "application/json;charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    if (req.url?.startsWith("/extension/")) {
      // Only transport outcomes; never log credentials, URLs, query strings or captions.
      const event = {
        at: new Date().toISOString(),
        action: req.url.startsWith("/extension/pair")
          ? "pair"
          : req.url === "/extension/jobs"
            ? "jobs"
            : "job",
        method: req.method,
        origin:
          req.headers.origin === origin
            ? "allowed"
            : req.headers.origin
              ? "other"
              : "missing",
        workspaceHeader: req.headers["x-ottspeed-client"] === "workspace",
      };
      res.on(
        "finish",
        () =>
          void appendFile(
            join(directory, "extension-requests.jsonl"),
            JSON.stringify({ ...event, status: res.statusCode }) + "\n",
            { mode: 0o600 },
          ).catch(() => {}),
      );
    }
    try {
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || ""))
        return send(403, { error: "Loopback host required." });
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.headers.origin && req.headers.origin !== origin)
        return send(403, { error: "Untrusted origin." });
      if (req.headers.origin === origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-OTTSpeed-Client",
        );
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      if (req.method === "OPTIONS") return send(204, {});
      if (url.pathname === "/healthz" && req.method === "GET")
        return send(200, {
          service: "ottspeed-translation-bridge",
          version: 1,
          ready: true,
          progressiveTranslation: true,
          workspaceAgentSupported: true,
          libraryArchiveSupported: true,
        });
      if (url.pathname === "/mcp") {
        if (req.headers.origin)
          return send(403, {
            error: "MCP is available only to the local tunnel transport.",
          });
        if (req.method !== "POST")
          return send(405, { error: "Use Streamable HTTP POST." });
        const body = await jsonBody(req);
        const mcp = makeMcpServer(store, audit);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (!url.pathname.startsWith("/extension/"))
        return send(404, { error: "Not found." });
      // Chrome extension GETs may omit Origin even though the pairing POST sends it.
      // Only an already paired bearer token can authorize such a GET; bootstrap
      // pairing and mutations still require the explicit permitted extension Origin.
      const pairedGetWithoutOrigin =
        !req.headers.origin &&
        req.method === "GET" &&
        equal(req.headers.authorization, `Bearer ${token}`);
      if (
        (req.headers.origin !== origin && !pairedGetWithoutOrigin) ||
        req.headers["x-ottspeed-client"] !== "workspace"
      )
        return send(403, { error: "Use the paired OTTSpeed workspace." });
      if (url.pathname === "/extension/pair" && req.method === "POST") {
        const body = await jsonBody(req);
        if (body.client !== "OTTSpeed")
          return send(400, { error: "Invalid pairing request." });
        return send(200, { token });
      }
      if (!equal(req.headers.authorization, `Bearer ${token}`))
        return send(401, { error: "브리지 연결을 다시 눌러주세요." });
      if (url.pathname === "/extension/library/archive" && req.method === "GET")
        return send(200, await archive.list());
      const archivedEpisode = /^\/extension\/library\/archive\/(\d+)$/.exec(
        url.pathname,
      );
      if (archivedEpisode && req.method === "GET")
        return send(200, await archive.episode(archivedEpisode[1]));
      if (url.pathname === "/extension/execution" && req.method === "GET")
        return send(200, launcher.configuration());
      if (url.pathname === "/extension/batches" && req.method === "POST")
        return send(200, await batches.create(await jsonBody(req)));
      if (url.pathname === "/extension/batches" && req.method === "GET")
        return send(200, { batches: await batches.list() });
      const batchMatch =
        /^\/extension\/batches\/([a-f0-9-]{36})(\/start)?$/i.exec(url.pathname);
      if (batchMatch) {
        const batch = await batches.get(batchMatch[1]);
        if (!batchMatch[2] && req.method === "GET") {
          const execution = await executionFor(batch);
          if (
            execution &&
            !execution.translationComplete &&
            execution.state !== "unavailable"
          )
            void launcher.status(batch, { refresh: true }).catch(() => {});
          return send(200, { ...batch, execution });
        }
        if (batchMatch[2] && req.method === "POST") {
          const body = await jsonBody(req);
          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            Object.keys(body).length ||
            batch.blockedCount
          )
            return send(400, {
              error:
                "Batch must contain unchanged fixed jobs and an empty start body.",
            });
          return send(200, await launcher.start(batch));
        }
      }
      if (url.pathname === "/extension/jobs" && req.method === "POST")
        return send(200, await store.create(await jsonBody(req)));
      if (url.pathname === "/extension/jobs" && req.method === "GET") {
        const jobs = await store.list(url.searchParams.get("mediaKey"));
        // Return local metadata promptly; slow upstream GETs must not delay B delivery.
        return send(200, {
          jobs: await Promise.all(
            jobs.map(async (job) => {
              const execution = await executionFor(job);
              if (
                execution &&
                !execution.translationComplete &&
                execution.state !== "unavailable"
              )
                void launcher.status(job, { refresh: true }).catch(() => {});
              return { ...job, execution };
            }),
          ),
        });
      }
      const start = /^\/extension\/jobs\/([a-f0-9-]{36})\/start$/i.exec(
        url.pathname,
      );
      if (start && req.method === "POST") {
        const body = await jsonBody(req);
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length
        )
          return send(400, {
            error: "Execution uses only the stored fixed job.",
          });
        return send(
          200,
          await launcher.start(await store.extensionJob(start[1])),
        );
      }
      const match = /^\/extension\/jobs\/([a-f0-9-]{36})$/i.exec(url.pathname);
      if (match && req.method === "GET") {
        const job = await store.extensionJob(match[1]);
        return send(200, { ...job, execution: await executionFor(job) });
      }
      return send(404, { error: "Unknown extension action." });
    } catch (error) {
      if (!res.headersSent) send(400, { error: error.message });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, store, batches, launcher, port: server.address().port };
}
