/* Read-only publication of verified local captures and whole-episode model
 * results. Does not create jobs, call a model or change the viewing tab. */
import assert from "node:assert/strict";
import { readFile, readdir, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";
import core from "../../subtitles/core.js";
import validation from "../../subtitles/capture-validation.js";
import { verifySavedRequest } from "../../scripts/subtitle-preparation.mjs";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
export class SubtitleLibraryArchive {
  constructor({
    privateRoot,
    archiveDirectory = join(privateRoot, "series-capture", "west-wing"),
    planDirectory = join(privateRoot, "chatgpt-plan", "episode-runs"),
  }) {
    this.privateRoot = resolve(privateRoot);
    this.archiveDirectory = resolve(archiveDirectory);
    this.planDirectory = resolve(planDirectory);
  }
  async confined(file, root = this.privateRoot) {
    const [actual, base] = await Promise.all([realpath(file), realpath(root)]),
      rel = relative(base, actual);
    assert(
      rel && !rel.startsWith("..") && !isAbsolute(rel),
      "Archive file escaped its private directory",
    );
    return actual;
  }
  async records() {
    let index;
    try {
      index = await json(
        await this.confined(join(this.archiveDirectory, "archive-index.json")),
      );
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    assert(
      index.kind === "ottspeed.netflix-series-archive" &&
        index.version === 1 &&
        index.status === "verified" &&
        Array.isArray(index.episodes),
      "Unverified subtitle archive",
    );
    assert.equal(index.episodes.length, index.episodeCount);
    assert.equal(
      new Set(index.episodes.map((e) => e.mediaKey)).size,
      index.episodeCount,
    );
    const runs = [];
    let names = [];
    try {
      names = await readdir(this.planDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const name of names.filter((n) => n.isDirectory())) {
      const dir = join(this.planDirectory, name.name);
      let report;
      try {
        report = await json(
          await this.confined(join(dir, "report.json"), this.planDirectory),
        );
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (
        report.phase === "verified_whole_episode" &&
        report.translationStructureVerified &&
        report.responseCompleted
      )
        runs.push({ dir, report });
    }
    return index.episodes.map((entry) => {
      assert(
        /^\d+$/.test(entry.videoId) &&
          entry.mediaKey === `netflix:${entry.videoId}` &&
          Number.isSafeInteger(entry.season) &&
          entry.season > 0 &&
          Number.isSafeInteger(entry.episode) &&
          entry.episode > 0,
        "Invalid archived episode identity",
      );
      const translations = runs.filter(
        (r) =>
          r.report.mediaKey === entry.mediaKey &&
          r.report.sourceHash === entry.sourceHash,
      );
      const catalog = {
        title: index.series,
        season: entry.season,
        episode: entry.episode,
        episodeTitle: entry.title || "",
      };
      const revision = digest({
        mediaKey: entry.mediaKey,
        sourceHash: entry.sourceHash,
        resourceSha256: entry.resourceSha256,
        catalog,
        translations: translations.map((r) => ({
          hash: r.report.responseSha256,
          model: r.report.responseModel,
          effort: r.report.responseReasoning?.effort,
        })),
      });
      return { entry, catalog, revision, translations };
    });
  }
  async list() {
    const records = await this.records();
    return {
      kind: "ottspeed.library-archive-index",
      version: 1,
      episodeCount: records.length,
      episodes: records.map(({ entry, catalog, revision, translations }) => ({
        mediaKey: entry.mediaKey,
        videoId: entry.videoId,
        catalog,
        revision,
        cueCount: entry.cueCount,
        translationCount: translations.length,
      })),
    };
  }
  async episode(videoId) {
    assert(/^\d+$/.test(videoId), "Invalid archive video ID");
    const record = (await this.records()).find(
      (r) => r.entry.videoId === videoId,
    );
    assert(record, "Archived episode not found");
    const { entry, catalog, revision } = record,
      capture = await json(await this.confined(entry.captureFile));
    assert.equal(capture.mediaKey, entry.mediaKey);
    assert.equal(capture.track.capture.resourceSha256, entry.resourceSha256);
    assert.equal(capture.track.cues.length, entry.cueCount);
    await validation.resource(
      { track: capture.track, rawText: capture.rawText },
      capture.media,
      DOMParser,
    );
    const request = await core.makeTranslationRequest({
      media: capture.media,
      source: capture.track,
      reference: null,
      mode: "translate",
    });
    assert.equal(request.sourceHash, entry.sourceHash);
    const translations = [];
    for (const { dir, report } of record.translations) {
      const saved = await json(
        await this.confined(
          join(dir, "translation-request.json"),
          this.planDirectory,
        ),
      );
      const response = await json(
        await this.confined(
          join(dir, "translation-response.json"),
          this.planDirectory,
        ),
      );
      await verifySavedRequest(saved);
      assert.equal(saved.mediaKey, entry.mediaKey);
      assert.equal(saved.sourceHash, entry.sourceHash);
      assert.equal(digest(response), report.responseSha256);
      const track = core.validateTranslationResponse(response, saved);
      const b = core.parse(
        await readFile(await this.confined(report.bVttPath, dir), "utf8"),
        "B.vtt",
      );
      assert.deepEqual(b.cues, track.cues);
      translations.push({
        request: saved,
        response,
        resultHash: digest(response),
        model: report.responseModel,
        reasoning: report.responseReasoning,
        createdAt: report.finishedAt,
        name: `${entry.key}.${report.responseModel}.${report.responseReasoning?.effort || "default"}.ko.B.vtt`,
      });
    }
    return {
      kind: "ottspeed.library-archive-episode",
      version: 1,
      revision,
      mediaKey: entry.mediaKey,
      media: capture.media,
      catalog,
      sourceHash: entry.sourceHash,
      sourceTrack: capture.track,
      translations,
    };
  }
}
