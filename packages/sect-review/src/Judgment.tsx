import { useEffect, useState } from "react";
import { request, type Item } from "./api";
import { Icon } from "./icons";

const labels: Record<string, string> = {
  text_fidelity: "Text fidelity",
  reading_order: "Reading order",
  structure: "Structure",
  table_associations: "Table associations",
};
export function Judgment({
  item,
  onSaved,
  onNext,
}: {
  item: Item;
  onSaved: () => Promise<void>;
  onNext: () => void;
}) {
  const [reviewer, setReviewer] = useState(
    localStorage.getItem("sect-reviewer") ?? "",
  );
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [correction, setCorrection] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState("locate"),
    [answerable, setAnswerable] = useState(""),
    [relevant, setRelevant] = useState(""),
    [supporting, setSupporting] = useState("");
  useEffect(() => {
    setChecks({});
    setNote("");
    setCorrection("");
    setError("");
    setSaved("");
    setQuery("");
    setKind("locate");
    setAnswerable("");
    setRelevant("");
    setSupporting("");
  }, [item.id]);
  async function submit(decision: string) {
    setBusy(true);
    setError("");
    try {
      if (
        item.kind === "benchmark" &&
        decision === "correct" &&
        (!query.trim() || !answerable)
      )
        throw new Error(
          "Enter your independent query and an answerability judgment.",
        );
      localStorage.setItem("sect-reviewer", reviewer);
      const body = {
        item: item.id,
        item_sha256: item.item_sha256,
        reviewer,
        decision,
        reason: note,
        checks,
        ...(decision === "correct"
          ? {
              correction:
                item.kind === "benchmark"
                  ? {
                      query,
                      kind,
                      answerable: answerable === "yes",
                      relevant: relevant
                        .split(/\r?\n/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                      supporting: supporting
                        .split(/\r?\n/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }
                  : JSON.parse(correction),
            }
          : {}),
      };
      const receipt = await (await request("/api/decision", body)).json();
      setSaved(`Saved · ${receipt.sha256.slice(0, 12)}`);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (item.locked)
    return (
      <aside className="judgment">
        <h2>Held-out task locked</h2>
        <p>{item.prompt}</p>
      </aside>
    );
  return (
    <aside className="judgment">
      <h2>Your judgment</h2>
      <label className="field">
        Reviewer
        <input
          placeholder="Enter your name"
          value={reviewer}
          onChange={(e) => setReviewer(e.target.value)}
          autoComplete="name"
        />
      </label>
      <p className="prompt">{item.prompt}</p>
      {item.kind === "benchmark" && (
        <div className="benchmark-fields">
          <label className="field">
            Your search question
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Write an independent information need"
            />
          </label>
          <label className="field">
            Question type
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {["locate", "define", "relations", "absence"].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Does the corpus answer it?
            <select
              value={answerable}
              onChange={(e) => setAnswerable(e.target.value)}
            >
              <option value="">Choose after checking sources</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          <label className="field">
            Relevant source revisions
            <textarea
              value={relevant}
              onChange={(e) => setRelevant(e.target.value)}
              placeholder="One revision ID per line. Browse and copy IDs from the source pane."
            />
          </label>
          <label className="field">
            Supporting source revisions
            <textarea
              value={supporting}
              onChange={(e) => setSupporting(e.target.value)}
              placeholder="One revision ID per line, including evidence you found independently."
            />
          </label>
          <button
            className="primary"
            disabled={busy}
            onClick={() => submit("correct")}
          >
            Save independent judgment
          </button>
        </div>
      )}
      {item.kind === "extraction" && (
        <>
          <h3>Checklist</h3>
          <div className="checklist">
            {Object.entries(labels).map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <select
                  aria-label={label}
                  value={checks[key] ?? ""}
                  onChange={(e) =>
                    setChecks({ ...checks, [key]: e.target.value })
                  }
                >
                  <option value="">Unset</option>
                  <option value="passed">Passed</option>
                  <option value="failed">Failed</option>
                  <option value="not_applicable">N/A</option>
                </select>
              </label>
            ))}
          </div>
        </>
      )}
      <label className="field notes">
        Notes
        <textarea
          placeholder="Describe your judgment and evidence…"
          maxLength={8000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <small>{note.length} / 8000 · A reason is required</small>
      </label>
      {(item.kind === "identity" ||
        item.kind === "profile" ||
        item.kind === "knowledge") && (
        <details>
          <summary>
            Correct this item
          </summary>
          <label className="field">
            Structured correction
            <textarea
              aria-label="Structured correction"
              placeholder={
                item.kind === "identity"
                  ? '{"from":[],"to":[]}'
                  : '{"evidence":[],"notes":""}'
              }
              value={correction}
              onChange={(e) => setCorrection(e.target.value)}
            />
          </label>
          <button disabled={busy} onClick={() => submit("correct")}>
            Save correction
          </button>
        </details>
      )}
      <div className="decision">
        <h3>Decision</h3>
        <div className="decision-buttons">
          {(item.kind === "benchmark"
            ? ["defer"]
            : ["accept", "reject", "defer"]
          ).map((choice) => (
            <button key={choice} disabled={busy} onClick={() => submit(choice)}>
              <Icon name={choice} />
              {choice[0].toUpperCase() + choice.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <button className="primary next" onClick={onNext}>
        Next region
        <Icon name="next" />
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="saved">
          {saved}
        </p>
      )}
      {item.receipt && (
        <p className="previous">
          Latest: {item.receipt.decision} · {item.receipt.reviewer}
        </p>
      )}
    </aside>
  );
}
