import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadCorpus } from "@sectgrep/convert";

export interface VerificationBinding {
  version: 1;
  staging: Record<string, string>;
  dependencies: Array<{ root: string; files: Record<string, string> }>;
}

export function within(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`path outside candidate: ${relative}`);
  return target;
}

function fingerprint(root: string, staging = false): Record<string, string> {
  const files: Record<string, string> = {};
  if (existsSync(root) && lstatSync(root).isFile()) {
    files[path.basename(root)] = createHash("sha256").update(readFileSync(root)).digest("hex");
    return files;
  }
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git" || name === ".sect" || staging && ["verify.json", "sample.json"].includes(name)) continue;
      const abs = path.join(dir, name);
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) throw new Error(`verification inputs cannot be symlinks: ${abs}`);
      if (stat.isDirectory()) walk(abs);
      else files[path.relative(root, abs).replaceAll("\\", "/")] = createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  walk(path.resolve(root));
  return files;
}

/** Bind the raw inputs and extraction recipes actually cited by this candidate. */
export function evidenceDependencies(roots: string[], work = "work"): string[] {
  const paths = new Set<string>();
  for (const root of roots) for (const doc of loadCorpus(root).docs) {
    const p = doc.front.provenance;
    if (!p) continue;
    if (p.raw) {
      const raw = String(p.raw);
      paths.add(path.isAbsolute(raw) ? raw : existsSync(path.join(root, raw)) ? path.join(root, raw) : path.resolve(raw));
    }
    if (p.raw_sha256) paths.add(path.resolve(work, String(p.raw_sha256)));
  }
  return [...paths];
}

export function bindVerification(runDir: string, dependencies: string[]): VerificationBinding {
  return { version: 1, staging: fingerprint(runDir, true), dependencies: [...new Set(dependencies.map((r) => path.resolve(r)))].filter((r) => r !== path.resolve(runDir)).map((root) => ({ root, files: fingerprint(root) })) };
}

export function assertBinding(runDir: string, binding?: VerificationBinding): void {
  if (!binding || binding.version !== 1) throw new Error("verification has no candidate binding; verify again");
  if (JSON.stringify(binding.staging) !== JSON.stringify(fingerprint(runDir, true))) throw new Error("staged bytes changed after verification; verify again");
  for (const dep of binding.dependencies) {
    if (JSON.stringify(dep.files) !== JSON.stringify(fingerprint(dep.root))) throw new Error(`verification dependency changed: ${dep.root}; verify again`);
  }
}
