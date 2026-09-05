import { useEffect, useState } from "react";
import { request } from "./api";

type Excerpt = { expr: string; title: string; text: string; spans: unknown[] };
type Hit = {
  id: string;
  expr: string;
  chunk_id: string;
  title: string;
  breadcrumb: string;
  snippet: string;
  evidence?: {
    primary: Excerpt;
    context: Excerpt[];
    continuation: { expr: string; reason: string }[];
    words: number;
    section_complete: boolean;
  };
};
type Search = {
  generation: string;
  elapsed_ms: number;
  current: { result: { hits: Hit[]; abstained: boolean } };
  before?: { query: string; response: { result: { hits: Hit[] } } }[];
  comparison_notice: string;
};
type Region = {
  id: string;
  text: string;
  kind: string;
  uncertainty: string[];
  locator: { type: string; page?: number; locations?: { page: number }[]; [key: string]: unknown };
};
type Inspection = {
  passage: {
    chunk_id: string;
    body: string;
    token_count: number;
    budget_unit: string;
    recipe: string;
    spans: unknown[];
  };
  sections: {
    expr: string;
    title: string;
    format: string;
    raw_sha256: string;
    ancestry: { id: string; title: string }[];
    regions: Region[];
    source_url: string;
  }[];
};

export function Retrieval() {
  const [queries, setQueries] = useState<string[]>([]),
    [query, setQuery] = useState("");
  const [result, setResult] = useState<Search | null>(null),
    [submittedQuery, setSubmittedQuery] = useState(""),
    [selected, setSelected] = useState(0),
    [inspection, setInspection] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [page, setPage] = useState<number | undefined>(),
    [image, setImage] = useState(""),
    [raw, setRaw] = useState("");
  const hit = result?.current.result.hits[selected];
  const section =
    inspection?.sections.find((s) => s.expr === hit?.expr) ??
    inspection?.sections[0];
  const pages = [
    ...new Set(
      section?.regions.flatMap((r) =>
        r.locator.type === "pages" ? r.locator.locations?.map(l => l.page) ?? [] : r.locator.page ? [r.locator.page] : [],
      ) ?? [],
    ),
  ];
  const before = result?.before?.find((x) => x.query === submittedQuery)
    ?.response.result.hits;
  useEffect(() => {
    let cancelled = false;
    request("/api/retrieval")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setQueries(data.queries);
          setQuery(data.queries[0] ?? "");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!hit) return;
    let cancelled = false;
    setInspection(null);
    setPage(undefined);
    setImage("");
    setRaw("");
    request(`/api/retrieval/passage?id=${encodeURIComponent(hit.chunk_id)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setInspection(data);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [result, hit?.chunk_id, hit?.expr]);
  useEffect(() => {
    if (!section) return;
    let cancelled = false;
    let blob = "";
    setImage("");
    setRaw("");
    const sourcePage = page && pages.includes(page) ? page : undefined;
    request(section.source_url + (sourcePage ? `&page=${sourcePage}` : ""))
      .then(async (response) => {
        if (response.headers.get("content-type")?.startsWith("image/")) {
          blob = URL.createObjectURL(await response.blob());
          if (!cancelled) setImage(blob);
          else URL.revokeObjectURL(blob);
        } else {
          const data = await response.json();
          if (!cancelled)
            setRaw(
              data.raw ??
                `${data.source_view ?? "Extracted regions"}\n\n${JSON.stringify(data.regions, null, 2)}`,
            );
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      if (blob) URL.revokeObjectURL(blob);
    };
  }, [section?.expr, page]);
  async function search() {
    setBusy(true);
    setError("");
    setInspection(null);
    try {
      const data = await (
        await request(`/api/retrieval/search?q=${encodeURIComponent(query)}`)
      ).json();
      setResult(data);
      setSubmittedQuery(query);
      setSelected(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="retrieval-layout">
      <div>
        <h1>Find the evidence</h1>
        <p>
          Inspect a diagnostic corpus: source → section → passage → returned
          evidence.
        </p>
      </div>
      <form
        className="retrieval-query"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label>
          Failure case
          <select
            aria-label="Failure case"
            value={queries.includes(query) ? query : ""}
            onChange={(e) => setQuery(e.target.value)}
          >
            <option value="">Custom query</option>
            {queries.map((q) => (
              <option key={q}>{q}</option>
            ))}
          </select>
        </label>
        <label>
          Search query
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button disabled={busy || !query.trim()} type="submit">
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <p className="retrieval-status">
          Generation {result.generation} · {Math.round(result.elapsed_ms)} ms
          including process startup ·{" "}
          {result.current.result.abstained
            ? "Nearest candidates; confidence threshold not met"
            : "Ranked evidence"}
          . {result.comparison_notice}
        </p>
      ) : (
        <p>
          Choose a case and run the search. Diagnostic comparisons do not create
          review decisions.
        </p>
      )}
      <div className="retrieval-columns">
        <section className="retrieval-pane">
          <h2>Search results</h2>
          {result?.current.result.hits.map((h, i) => (
            <button
              className={`retrieval-hit ${i === selected ? "active" : ""}`}
              key={h.chunk_id}
              onClick={() => setSelected(i)}
            >
              <strong>
                {i + 1}. {h.title}
              </strong>
              <span>{h.breadcrumb}</span>
              <p>{h.snippet}</p>
            </button>
          ))}
          {before ? (
            <details>
              <summary>Original results for this case</summary>
              <p>
                The original comparison uses the earlier 33-document pilot. This
                view diagnoses evidence display; it is not a matched-corpus
                accuracy score.
              </p>
              {before.map((h) => (
                <article key={h.chunk_id}>
                  <h3>{h.title}</h3>
                  <p>{h.snippet}</p>
                </article>
              ))}
            </details>
          ) : null}
        </section>
        <section className="retrieval-pane">
          <h2>Passage and context</h2>
          {inspection ? (
            <>
              <p>
                {inspection.passage.token_count}{" "}
                {inspection.passage.budget_unit} · {inspection.passage.recipe}
              </p>
              <h3>Recovered section path</h3>
              <ol>
                {section?.ancestry.map((a) => (
                  <li key={a.id}>{a.title}</li>
                ))}
                <li>{section?.title}</li>
              </ol>
              <h3>Compiled passage</h3>
              <pre>{inspection.passage.body}</pre>
              <details>
                <summary>Exact source ranges</summary>
                <pre>{JSON.stringify(inspection.passage.spans, null, 2)}</pre>
              </details>
              <h3>Returned supporting context</h3>
              {hit?.evidence?.context.map((c, i) => (
                <article key={`${c.expr}:${i}`}>
                  <h3>{c.title}</h3>
                  <code>{c.expr}</code>
                  <pre>{c.text}</pre>
                </article>
              ))}
              {hit?.evidence?.continuation.map((c, i) => (
                <p key={`${c.expr}:${i}`}>
                  Continue reading {c.expr}: {c.reason}
                </p>
              ))}
              <details>
                <summary>Source regions and parser uncertainty</summary>
                {section?.regions.map((r) => (
                  <article key={r.id}>
                    <h3>{r.kind}</h3>
                    <p>{r.text}</p>
                    <code>{JSON.stringify(r.locator)}</code>
                    {r.uncertainty.length ? (
                      <p>{r.uncertainty.join(", ")}</p>
                    ) : null}
                  </article>
                ))}
              </details>
            </>
          ) : (
            <p>{hit ? "Loading passage…" : "Select a search result."}</p>
          )}
        </section>
        <section className="retrieval-pane">
          <h2>Original source</h2>
          {pages.length ? (
            <label>
              PDF page
              <select
                value={page ?? pages[0]}
                onChange={(e) => setPage(Number(e.target.value))}
              >
                {pages.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {image ? (
            <a
              href={image}
              target="_blank"
              rel="noreferrer"
              title="Open original page at full size"
            >
              <img
                className="retrieval-source"
                src={image}
                alt={`Original PDF page ${page ?? pages[0]}`}
              />
              <span>Open page at full size</span>
            </a>
          ) : raw ? (
            <pre>{raw}</pre>
          ) : (
            <p>
              {section
                ? "Loading original…"
                : "Source appears after selecting a result."}
            </p>
          )}
          {section ? (
            <details>
              <summary>Source revision</summary>
              <code>{section.expr}</code>
              <p>SHA-256 {section.raw_sha256}</p>
            </details>
          ) : null}
        </section>
      </div>
    </main>
  );
}
