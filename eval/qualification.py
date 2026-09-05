"""Reproducible retrieval evaluation. Missing independent evidence blocks qualification.

Standard library only. Run `python eval/qualification.py --help` from the workspace.
One JSONL task per line: id, split, domain, discipline, kind, query, relevant (revision
IDs), supporting (revision IDs), no_answer, labeler, independent, and optional filters.
This runner consumes labels; it does not create or infer human judgments.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import platform
import os
import queue
import random
import statistics
import subprocess
import threading
import time
from pathlib import Path

VARIANTS = {
    "body-bm25": {"baseline": "body-bm25"},
    "plain-hybrid": {"baseline": "plain-hybrid"},
    "sect": {"relations": "off"},
    "explicit": {"relations": "explicit"},
    "verified": {"relations": "verified"},
}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_freeze(file):
    if not file:
        raise ValueError("held-out evaluation requires --freeze from the review workflow")
    frozen = json.loads(Path(file).read_text(encoding="utf-8"))
    bindings = frozen.get("recipe_bindings", {})
    if not bindings or not frozen.get("tuning_sha256") or not frozen.get("topic_review_sha256"):
        raise ValueError("incomplete benchmark freeze")
    if any(digest(name) != expected for name, expected in bindings.items()):
        raise ValueError("frozen parser/profile/prompt/ranking implementation changed")
    return digest(file)


def validate_tasks(tasks):
    seen, queries = set(), {}
    for task in tasks:
        if not task.get("id") or task["id"] in seen:
            raise ValueError("task IDs must be unique and nonempty")
        seen.add(task["id"])
        if task.get("split") not in {"tuning", "heldout", "smoke"}:
            raise ValueError("invalid task split")
        if task.get("domain") not in {"lending", "research"}:
            raise ValueError("invalid task domain")
        if task["domain"] == "research" and task.get("discipline") not in {"ml", "biomedical"}:
            raise ValueError("research tasks need a discipline")
        if not isinstance(task.get("query"), str) or not task["query"].strip():
            raise ValueError("empty query")
        normalized = " ".join(task["query"].lower().split())
        if normalized in queries and queries[normalized] != task["split"]:
            raise ValueError("query leakage across splits")
        queries[normalized] = task["split"]
        if not isinstance(task.get("no_answer"), bool):
            raise ValueError("no_answer must be explicit")
        for field in ("relevant", "supporting"):
            if not isinstance(task.get(field), list) or any(not isinstance(i, str) or "@" not in i for i in task[field]):
                raise ValueError("labels must be lists of exact revision IDs")
        if task["no_answer"] and (task["relevant"] or task["supporting"]):
            raise ValueError("no-answer task has evidence labels")
        if task.get("timing_only") and task["split"] != "smoke":
            raise ValueError("timing-only tasks belong in the smoke split")
        if not task["no_answer"] and not task["relevant"] and not task.get("timing_only"):
            raise ValueError("answerable task has no primary evidence labels")
        filters = task.get("filters", {})
        if not isinstance(filters, dict) or any(k not in {"scope", "source", "kind", "as_of"} or not isinstance(v, str) for k, v in filters.items()):
            raise ValueError("task filters must be explicit scope/source/kind/as_of strings")
    return tasks


def score(task, result, k=5):
    if task.get("timing_only"):
        return {"recall_at_5": None, "precision_at_5": None, "support_recall": None, "no_answer_correct": None, "context_words": sum(len(c.get("body", "").split()) for c in result.get("supporting_context", []))}
    primary = set(h["expr"] for h in result.get("hits", [])[:k])
    retrieved = primary | {c["expr"] for c in result.get("supporting_context", [])}
    gold, support = set(task["relevant"]), set(task["supporting"])
    return {
        "recall_at_5": len(primary & gold) / len(gold) if gold else None,
        "precision_at_5": len(primary & gold) / k if gold else None,
        "support_recall": len(retrieved & support) / len(support) if support else None,
        "no_answer_correct": int(bool(result.get("abstained"))) if task["no_answer"] else None,
        "context_words": sum(len(c.get("body", "").split()) for c in result.get("supporting_context", [])),
    }


def interval(values):
    values = [v for v in values if v is not None]
    if not values:
        return {"n": 0, "mean": None, "ci95": None}
    rng = random.Random(41)
    draws = sorted(statistics.mean(rng.choices(values, k=len(values))) for _ in range(1000))
    return {"n": len(values), "mean": statistics.mean(values), "ci95": [draws[24], draws[974]]}


def percentile(values, p):
    return sorted(values)[max(0, math.ceil(len(values) * p) - 1)] if values else None


class Mcp:
    def __init__(self, binary, corpus, freshness="no", timeout=120):
        self.request_timeout = timeout
        arguments = [str(binary), "--corpus", str(corpus)]
        if freshness is not None:
            arguments += ["--freshness", freshness]
        self.child = subprocess.Popen(arguments + ["serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
        self.lines = queue.Queue()
        def read():
            for line in self.child.stdout:
                self.lines.put(line)
            self.lines.put(None)
        threading.Thread(target=read, daemon=True).start()
        self.serial = 0
        self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "sect-qualification", "version": "1"}})
        self.child.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.child.stdin.flush()

    def request(self, method, params):
        self.serial += 1
        self.child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.serial, "method": method, "params": params}) + "\n")
        self.child.stdin.flush()
        while True:
            line = self.lines.get(timeout=self.request_timeout)
            if line is None:
                raise RuntimeError("MCP closed stdout")
            response = json.loads(line)
            if response.get("id") == self.serial:
                if "error" in response:
                    raise RuntimeError(response["error"])
                return response["result"]

    def search(self, arguments):
        response = self.request("tools/call", {"name": "sect_search", "arguments": arguments})
        if response.get("isError"):
            raise RuntimeError(response)
        return response["structuredContent"]["result"]

    def close(self):
        self.child.stdin.close()
        try:
            self.child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()

    def peak_rss(self):
        if os.name != "nt":
            try:
                for line in Path(f"/proc/{self.child.pid}/status").read_text().splitlines():
                    if line.startswith("VmHWM:"):
                        return int(line.split()[1]) * 1024
            except OSError:
                return None
        else:
            import ctypes
            from ctypes import wintypes
            class Counters(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [(name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.OpenProcess(0x0400 | 0x0010, False, self.child.pid)
            if not handle:
                return None
            try:
                counters = Counters()
                counters.cb = ctypes.sizeof(counters)
                fn = ctypes.WinDLL("psapi").GetProcessMemoryInfo
                fn.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
                return counters.PeakWorkingSetSize if fn(handle, ctypes.byref(counters), counters.cb) else None
            finally:
                kernel.CloseHandle(handle)
        return None


def prerequisites(tasks, evidence):
    blockers = []
    for split, minimum in (("tuning", 50), ("heldout", 100)):
        for domain in ("lending", "research"):
            selected = [t for t in tasks if t["split"] == split and t["domain"] == domain]
            if len(selected) < minimum:
                blockers.append(f"{split}/{domain}: requires {minimum} tasks")
            if any(not t.get("labeler") or t.get("independent") is not True for t in selected):
                blockers.append(f"{split}/{domain}: independently checked human labels missing")
            if domain == "research" and {t.get("discipline") for t in selected} != {"ml", "biomedical"}:
                blockers.append(f"{split}: both research disciplines required")
    if evidence.get("human_checked_regions", 0) < 60:
        blockers.append("60 manually checked extraction regions missing")
    if evidence.get("real_searchable_units", 0) < 100000:
        blockers.append("100k real searchable units missing")
    for platform_name in ("windows", "linux"):
        p = evidence.get("platforms", {}).get(platform_name, {})
        for key, maximum in (("warm_p95_ms", 500), ("cold_p95_ms", 2000), ("rss_bytes", 2 * 1024**3)):
            if not isinstance(p.get(key), (int, float)) or not 0 <= p[key] <= maximum:
                blockers.append(f"{platform_name}: {key} gate not met")
    if evidence.get("invariants_pass_rate") != 1:
        blockers.append("exact/structural/temporal invariants not qualified")
    if evidence.get("accepted_relation_precision", 0) < .95 or "accepted_relation_coverage" not in evidence:
        blockers.append("accepted relation precision/coverage missing or below gate")
    runs = evidence.get("agent_runs", [])
    if len(runs) < 3 or any(r.get("tool_call_reduction", 0) < .30 or r.get("accuracy_delta", -1) < 0 for r in runs):
        blockers.append("three agent runs with >=30% fewer calls and no accuracy regression missing")
    # An untraceable numeric assertion is not an acceptance record.
    if not evidence.get("reviewer") or not evidence.get("artifact_hashes"):
        blockers.append("release evidence requires a reviewer and artifact hashes")
    return blockers


def report(tasks, rows, evidence):
    summary = {}
    for variant in sorted({r["variant"] for r in rows}):
        selected = [r for r in rows if r["variant"] == variant]
        summary[variant] = {"domains": {}, "warm_p95_ms": percentile([ms for r in selected for ms in r["warm_ms"]], .95), "cold_p95_ms": percentile([ms for r in selected for ms in r["cold_ms"]], .95)}
        for domain in ("lending", "research"):
            domain_rows = [r for r in selected if r["domain"] == domain and r["split"] == "heldout"]
            summary[variant]["domains"][domain] = {key: interval([r["metrics"][key] for r in domain_rows if key != "recall_at_5" or r["kind"] in {"locate", "define"}]) for key in ("recall_at_5", "precision_at_5", "support_recall", "no_answer_correct")}
    blockers = prerequisites(tasks, evidence)
    for domain in ("lending", "research"):
        base = summary.get("sect", {}).get("domains", {}).get(domain, {})
        connected = summary.get("verified", {}).get("domains", {}).get(domain, {})
        for key, minimum in (("recall_at_5", .90), ("no_answer_correct", .90)):
            value = connected.get(key, {}).get("mean")
            if value is None or value < minimum:
                blockers.append(f"{domain}: {key} missing or below {minimum}")
        for key, delta, sign in (("support_recall", .10, 1), ("precision_at_5", -.02, 1)):
            a, b = base.get(key, {}).get("mean"), connected.get(key, {}).get("mean")
            if a is None or b is None or (b - a) * sign < delta:
                blockers.append(f"{domain}: {key} improvement gate not met")
    return {"qualified": not blockers, "blockers": blockers, "summary": summary}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--corpus", required=True, type=Path)
    parser.add_argument("--tasks", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--freeze", type=Path, help="Required for held-out runs; emitted by pipeline freeze")
    parser.add_argument("--split", choices=["tuning", "heldout", "smoke"], default="smoke")
    parser.add_argument("--variants", nargs="+", choices=VARIANTS, default=list(VARIANTS))
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--fts", action="store_true", help="Diagnostic lexical-only run; cannot qualify hybrid retrieval")
    args = parser.parse_args()
    freeze_sha = verify_freeze(args.freeze) if args.split == "heldout" else None
    tasks = validate_tasks([json.loads(line) for line in args.tasks.read_text(encoding="utf-8-sig").splitlines() if line.strip()])
    chosen = [t for t in tasks if t["split"] == args.split]
    if not chosen or args.repeats < 1:
        parser.error("nonempty task split and positive repeats required")
    binary, corpus = args.binary.resolve(), args.corpus.resolve()
    status = subprocess.run([str(binary), "status", "--corpus", str(corpus), "--freshness", "no", "--json"], check=True, capture_output=True, text=True, encoding="utf-8")
    pinned = json.loads(status.stdout)
    if pinned["freshness"]["state"] != "fresh":
        raise ValueError("freeze and rebuild the corpus before evaluating")
    session = Mcp(binary, corpus)
    rows = []
    peak_rss = None
    try:
        for variant in args.variants:
            for task in chosen:
                arguments = {"query": task["query"], "limit": 5, "explain": True, **VARIANTS[variant], **task.get("filters", {})}
                if args.fts:
                    arguments["fts"] = True
                session.search(arguments)  # Excluded warm-up.
                warm, cold = [], []
                result = None
                for _ in range(args.repeats):
                    start = time.perf_counter()
                    result = session.search(arguments)
                    warm.append((time.perf_counter() - start) * 1000)
                    command = [str(binary), "--corpus", str(corpus), "--freshness", "no", "--json", "search", task["query"]]
                    for key, value in arguments.items():
                        if key == "query" or value is False or value is None:
                            continue
                        command.append("--" + key.replace("_", "-"))
                        if value is not True:
                            command.append(str(value))
                    start = time.perf_counter()
                    proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=120, check=True)
                    cold.append((time.perf_counter() - start) * 1000)
                    if json.loads(proc.stdout)["result"] != result:
                        raise ValueError("warm MCP and cold CLI results differ")
                rows.append({"id": task["id"], "variant": variant, "domain": task["domain"], "split": task["split"], "kind": task.get("kind", "locate"), "warm_ms": warm, "cold_ms": cold, "metrics": score(task, result), "result": result})
        peak_rss = session.peak_rss()
    finally:
        session.close()
    final_status = subprocess.run([str(binary), "status", "--corpus", str(corpus), "--freshness", "no", "--json"], check=True, capture_output=True, text=True, encoding="utf-8")
    final_index = json.loads(final_status.stdout)
    if final_index["freshness"]["state"] != "fresh" or final_index["result"]["generation"] != pinned["result"]["generation"]:
        raise ValueError("corpus changed during evaluation; discard this run")
    evidence = json.loads(args.evidence.read_text()) if args.evidence else {}
    output = {"schema_version": 1, "created_at": dt.datetime.now(dt.timezone.utc).isoformat(), "environment": {"platform": platform.platform(), "processor": platform.processor(), "python": platform.python_version(), "binary_sha256": digest(binary), "tasks_sha256": digest(args.tasks)}, "index": pinned["result"], "release": report(tasks, rows, evidence), "rows": rows}
    output["environment"]["warm_mcp_peak_rss_bytes"] = peak_rss
    if freeze_sha:
        if verify_freeze(args.freeze) != freeze_sha:
            raise ValueError("benchmark freeze changed during evaluation")
        output["environment"]["benchmark_freeze_sha256"] = freeze_sha
    if args.fts or args.split != "heldout":
        output["release"]["qualified"] = False
        output["release"]["blockers"].append("diagnostic/tuning run is not held-out hybrid qualification")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"tasks": len(chosen), "rows": len(rows), "qualified": output["release"]["qualified"], "output": str(args.output)}))


if __name__ == "__main__":
    main()
