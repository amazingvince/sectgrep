import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomic, exclusiveSync, json, safePath } from "./io.js";

interface Journal {
  token: string;
  state: "writing" | "indexing" | "published" | "restored";
  before: Record<string, string | null>;
  markers: string[];
}
const markers = (corpus: string) =>
  existsSync(path.join(corpus, ".sect/published"))
    ? readdirSync(path.join(corpus, ".sect/published"))
        .filter((x) => x.endsWith(".ready"))
        .sort()
    : [];

/** Same .sect/merge.lock barrier and Rust immutable generation publisher used by legacy merge. */
export async function publishFiles(
  corpus: string,
  outputs: Record<string, string | Buffer>,
  bin: string,
  guard: (phase: "before" | "after") => void = () => {},
): Promise<{ files: number; generation: string | null }> {
  return publishFilesSync(corpus, outputs, bin, guard);
}
export function publishFilesSync(
  corpus: string,
  outputs: Record<string, string | Buffer>,
  bin: string,
  guard: (phase: "before" | "after") => void = () => {},
): { files: number; generation: string | null } {
  corpus = path.resolve(corpus);
  const root = safePath(corpus, ".sect");
  mkdirSync(root, { recursive: true });
  return exclusiveSync(path.join(root, "publication.sqlite"), () => {
    const barrier = path.join(root, "merge.lock");
    const journalPath = path.join(root, "publication.json");
    const restore = (journal: Journal) => {
      for (const [relative, bytes] of Object.entries(
        journal.before,
      ).reverse()) {
        const file = safePath(corpus, relative);
        if (bytes === null) {
          if (existsSync(file)) unlinkSync(file);
        } else {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, Buffer.from(bytes, "base64"));
        }
      }
    };
    if (existsSync(barrier)) {
      if (!existsSync(journalPath))
        throw new Error(
          "legacy publication barrier needs its owner's recovery",
        );
      const old = json<Journal>(journalPath);
      if (readFileSync(barrier, "utf8") !== old.token)
        throw new Error("another publisher owns the barrier");
      // With the OS writer lock held, a leftover matching barrier belongs to an interrupted run.
      const selected = markers(corpus).some((m) => !old.markers.includes(m));
      if (!selected && old.state !== "published") restore(old);
      old.state = selected ? "published" : "restored";
      atomic(journalPath, old);
      unlinkSync(barrier);
    }
    guard("before");
    const executable =
      bin.includes("/") || bin.includes("\\") ? path.resolve(bin) : bin;
    if (spawnSync(executable, ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("publication requires a working sect binary");
    const journal: Journal = {
      token: randomUUID(),
      state: "writing",
      before: {},
      markers: markers(corpus),
    };
    // Journal precedes the barrier; readers see either old bytes or the publication barrier.
    atomic(journalPath, journal);
    writeFileSync(barrier, journal.token, { flag: "wx" });
    let published = false;
    try {
      for (const [relative, bytes] of Object.entries(outputs)) {
        if (relative.startsWith(".sect") || relative.startsWith(".git"))
          throw new Error("publication cannot overwrite internal state");
        const file = safePath(corpus, relative);
        journal.before[relative] = existsSync(file)
          ? readFileSync(file).toString("base64")
          : null;
      }
      atomic(journalPath, journal);
      for (const [relative, bytes] of Object.entries(outputs)) {
        const file = safePath(corpus, relative);
        if (existsSync(file) && readFileSync(file).equals(Buffer.from(bytes)))
          continue;
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      }
      guard("after");
      journal.state = "indexing";
      atomic(journalPath, journal);
      const result = spawnSync(executable, ["index", corpus], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, SECT_MERGE_TOKEN: journal.token },
      });
      if (result.status !== 0)
        throw new Error(
          `sect index failed; corpus restored: ${(result.stderr || result.stdout).slice(-1000)}`,
        );
      published = true;
      journal.state = "published";
      atomic(journalPath, journal);
      return {
        files: Object.keys(outputs).length,
        generation: markers(corpus).at(-1) ?? null,
      };
    } catch (error) {
      if (!published) {
        restore(journal);
        journal.state = "restored";
        atomic(journalPath, journal);
      }
      throw error;
    } finally {
      unlinkSync(barrier);
    }
  });
}
