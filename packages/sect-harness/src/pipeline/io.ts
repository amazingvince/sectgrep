import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const digest = (value: unknown) => hash(canonical(value));
export const json = <T>(file: string): T =>
  JSON.parse(readFileSync(file, "utf8"));
export function atomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  renameSync(temp, file);
}
/** Reject symlink traversal, including any existing ancestor of a new destination. */
export function safePath(root: string, relative: string): string {
  const base = path.resolve(root);
  const dest = path.resolve(base, relative);
  const rel = path.relative(base, dest);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`))
    throw new Error("path escapes root");
  for (let p = dest; ; p = path.dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw new Error("symlink in artifact path");
    if (p === path.dirname(p)) break;
  }
  return dest;
}
export function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (rel: string) => {
    const abs = safePath(root, rel);
    if (!existsSync(abs)) return;
    if (lstatSync(abs).isDirectory())
      for (const name of readdirSync(abs).sort()) {
        if (name !== ".sect" && name !== ".git") walk(path.join(rel, name));
      }
    else result[rel.replaceAll("\\", "/")] = hash(readFileSync(abs));
  };
  walk("");
  return result;
}
/** OS-managed SQLite write lock: released on process death, with no age-based stealing. */
export async function exclusive<T>(
  file: string,
  task: () => Promise<T> | T,
): Promise<T> {
  safePath(path.dirname(file), path.basename(file));
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(
      "PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS mutex (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE",
    );
    try {
      const out = await task();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export function exclusiveSync<T>(file: string, task: () => T): T {
  safePath(path.dirname(file), path.basename(file));
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(
      "PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS mutex (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE",
    );
    try {
      const out = task();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}
