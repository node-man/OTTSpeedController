/* Durable batches refer to immutable jobs. No new collection, translation or model calls. */
import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "./job-store.mjs";
import core from "../../subtitles/core.js";
const valid = (id) => /^[a-f0-9-]{36}$/i.test(id || "");
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};
async function validateJob(job) {
  const r = job.request;
  requireValue(
    r?.mode === "translate" &&
      r.reference === null &&
      job.sourceTrack?.capture?.fullEpisode &&
      job.sourceTrack.sync?.offsetMs === 0 &&
      job.sourceTrack.sync?.scale === 1,
    "Batch source must be the fixed Netflix original.",
  );
  const fresh = await core.makeTranslationRequest({
    media: r.media,
    source: job.sourceTrack,
    reference: null,
    mode: "translate",
  });
  requireValue(
    fresh.sourceHash === r.sourceHash &&
      JSON.stringify(fresh.slots) === JSON.stringify(r.slots) &&
      JSON.stringify(fresh.source) === JSON.stringify(r.source),
    "Fixed source snapshot changed.",
  );
}
export class TranslationBatchStore {
  constructor(store) {
    this.store = store;
    this.directory = join(store.directory, "batches");
    this.queue = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    return this;
  }
  path(id) {
    requireValue(valid(id), "Invalid batch ID.");
    return join(this.directory, `${id}.json`);
  }
  async load(id) {
    return JSON.parse(await readFile(this.path(id), "utf8"));
  }
  async list() {
    const ids = (await readdir(this.directory)).filter((f) =>
      /^[a-f0-9-]{36}\.json$/i.test(f),
    );
    return Promise.all(
      ids.map(async (file) => {
        const batchId = file.slice(0, -5);
        try {
          return await this.get(batchId);
        } catch {
          return {
            batchId,
            status: "blocked",
            sourceHash: null,
            entries: [],
            reason: "batch_record_unavailable",
          };
        }
      }),
    );
  }
  async create({ jobIds }) {
    requireValue(
      Array.isArray(jobIds) &&
        jobIds.length > 0 &&
        jobIds.length <= 100 &&
        jobIds.every(valid) &&
        new Set(jobIds).size === jobIds.length,
      "Select 1–100 distinct existing jobs.",
    );
    const run = this.queue.then(async () => {
      const entries = [];
      for (const id of jobIds) {
        const job = await this.store.load(id);
        await validateJob(job);
        entries.push({
          jobId: id,
          sourceHash: job.request.sourceHash,
          mediaKey: job.request.mediaKey,
        });
      }
      requireValue(
        new Set(entries.map((e) => e.mediaKey)).size === entries.length,
        "Select only one source version per episode.",
      );
      const sourceHash = digest(entries);
      for (const previous of await this.list())
        if (previous.sourceHash === sourceHash) return previous;
      const batchId = randomUUID(),
        record = {
          kind: "ottspeed.translation-batch",
          schemaVersion: 1,
          batchId,
          sourceHash,
          entries,
          createdAt: new Date().toISOString(),
        };
      await this.store.atomic(this.path(batchId), record);
      return this.get(batchId);
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async get(id) {
    const record = await this.load(id);
    requireValue(
      record.kind === "ottspeed.translation-batch" &&
        record.schemaVersion === 1 &&
        record.batchId === id &&
        Array.isArray(record.entries) &&
        record.entries.length > 0 &&
        record.entries.length <= 100 &&
        digest(record.entries) === record.sourceHash,
      "Invalid batch record.",
    );
    const entries = [];
    for (const expected of record.entries) {
      requireValue(
        valid(expected.jobId) &&
          typeof expected.mediaKey === "string" &&
          /^[a-f0-9]{64}$/.test(expected.sourceHash),
        "Invalid batch job reference.",
      );
      try {
        const job = await this.store.load(expected.jobId);
        await validateJob(job);
        if (
          job.request.sourceHash !== expected.sourceHash ||
          job.request.mediaKey !== expected.mediaKey
        )
          throw new Error("changed");
        const state = this.store.summary(job);
        entries.push({
          ...expected,
          episode: state.episode,
          status: state.status,
          cueCount: state.cueCount,
          readyCueCount: state.readyCueCount,
          readyThroughMs: state.readyThroughMs,
          chunkCount: state.chunkCount,
          savedChunkCount: state.savedChunkCount,
          readChunkCount: state.readChunkCount,
        });
      } catch {
        entries.push({
          ...expected,
          status: "blocked",
          cueCount: 0,
          readyCueCount: 0,
          reason: "job_missing_or_changed",
        });
      }
    }
    const completedCount = entries.filter(
        (e) => e.status === "complete",
      ).length,
      blockedCount = entries.filter((e) => e.status === "blocked").length;
    return {
      ...record,
      jobId: record.batchId,
      mediaKey: `batch:${record.batchId}`,
      entries,
      completedCount,
      blockedCount,
      pendingCount: entries.length - completedCount - blockedCount,
      readyCueCount: entries.reduce((n, e) => n + e.readyCueCount, 0),
      cueCount: entries.reduce((n, e) => n + e.cueCount, 0),
      status: blockedCount
        ? "blocked"
        : completedCount === entries.length
          ? "complete"
          : "translating",
    };
  }
}
