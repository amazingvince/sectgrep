import React, { useEffect, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { getItems, exportDecisions, type Item } from "./api";
import { Icon } from "./icons";
import { Evidence } from "./Evidence";
import { Judgment } from "./Judgment";
import "./style.css";
const modes = ["overview", "extraction", "knowledge", "benchmark"];
const Retrieval = lazy(() =>
  import("./Retrieval").then((m) => ({ default: m.Retrieval })),
);
const label = (s: string) =>
  s === "ml" ? "Machine learning" : s[0]?.toUpperCase() + s.slice(1);
function App() {
  const [data, setData] = useState<{
    name: string;
    items: Item[];
    retrieval?: boolean;
  }>({
    name: "Corpus creation pilot",
    items: [],
  });
  const [mode, setMode] = useState("extraction"),
    [selected, setSelected] = useState<string | null>(null),
    [filter, setFilter] = useState(""),
    [error, setError] = useState(""),
    [page, setPage] = useState(0);
  async function refresh() {
    try {
      const next = await getItems();
      setData(next);
      if (next.retrieval && !data.retrieval) setMode("retrieval");
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    setPage(0);
    setSelected(null);
  }, [mode, filter]);
  const items = data.items.filter(
    (i) =>
      (mode === "knowledge"
        ? ["knowledge", "identity", "profile"].includes(i.kind)
        : i.kind === mode) &&
      (!filter || i.document === filter),
  );
  const visible = items.slice(page * 10, page * 10 + 10),
    item =
      visible.find((i) => i.id === selected) ??
      visible.find((i) => !i.receipt || i.receipt.decision === "defer") ??
      visible[0];
  const next = () => {
    if (item) {
      const n = (items.findIndex((x) => x.id === item.id) + 1) % items.length;
      setPage(Math.floor(n / 10));
      setSelected(items[n]?.id ?? null);
    }
  };
  return (
    <div className="app">
      <nav className="rail">
        <div className="brand">
          <span>Sect</span>
          <br />
          Review
        </div>
        <div className="nav-items">
          {(data.retrieval ? ["retrieval", ...modes] : modes).map((m) => (
            <button
              key={m}
              className={mode === m ? "active" : ""}
              onClick={() => {
                setMode(m);
                setFilter("");
              }}
            >
              <Icon name={m} />
              {label(m)}
            </button>
          ))}
        </div>
      </nav>
      <header>
        <Icon name="menu" />
        <div className="run-name">
          <span>Run</span>
          <strong>{data.name}</strong>
        </div>
        <div className="pending">
          <span>Pending review</span>
          <strong>
            {
              data.items.filter(
                (i) => !i.receipt || i.receipt.decision === "defer",
              ).length
            }
          </strong>
        </div>
        <button
          className="export"
          onClick={() => exportDecisions().catch((e) => setError(String(e)))}
        >
          <Icon name="download" />
          Export decisions
        </button>
      </header>
      {error && (
        <p className="global-error" role="alert">
          {error}
        </p>
      )}
      {mode === "retrieval" ? (
        <Suspense fallback={<main className="empty">Loading inspector…</main>}>
          <Retrieval />
        </Suspense>
      ) : mode === "overview" ? (
        <main className="overview">
          <h1>Corpus review</h1>
          <p>
            Independent source judgments remain separate from parser checks and
            model agreement.
          </p>
          <table>
            <thead>
              <tr>
                <th>Queue</th>
                <th>Items</th>
                <th>Pending</th>
                <th>Reviewed</th>
              </tr>
            </thead>
            <tbody>
              {[
                "extraction",
                "profile",
                "knowledge",
                "identity",
                "benchmark",
              ].map((kind) => {
                const rows = data.items.filter((i) => i.kind === kind);
                return (
                  <tr key={kind}>
                    <td>{kind}</td>
                    <td>{rows.length}</td>
                    <td>
                      {
                        rows.filter(
                          (i) => !i.receipt || i.receipt.decision === "defer",
                        ).length
                      }
                    </td>
                    <td>
                      {
                        rows.filter(
                          (i) => i.receipt && i.receipt.decision !== "defer",
                        ).length
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p>
            Quality qualification is pending independent judgments. Known scale
            limits remain a separate release gate.
          </p>
        </main>
      ) : (
        <>
          <aside className="queue">
            <div className="queue-heading">
              <h2>{label(mode)} review</h2>
              <div className="pagination">
                <button
                  aria-label="Previous batch"
                  disabled={!page}
                  onClick={() => setPage(page - 1)}
                >
                  ←
                </button>
                <p>
                  Batch {page + 1} / {Math.max(1, Math.ceil(items.length / 10))}
                </p>
                <button
                  aria-label="Next batch"
                  disabled={(page + 1) * 10 >= items.length}
                  onClick={() => setPage(page + 1)}
                >
                  →
                </button>
              </div>
              <select
                aria-label="Filter documents"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="">All documents</option>
                {[...new Set(data.items.map((i) => i.document))]
                  .sort()
                  .map((id) => (
                    <option key={id}>{id}</option>
                  ))}
              </select>
            </div>
            <div className="queue-scroll">
              {[...new Set(visible.map((i) => i.domain))].map((domain) => (
                <section key={domain}>
                  <h3>
                    {label(domain)}
                    <span>
                      {visible.filter((i) => i.domain === domain).length}
                    </span>
                  </h3>
                  {visible
                    .filter((i) => i.domain === domain)
                    .map((i) => (
                      <button
                        className={`queue-row ${i.id === item?.id ? "selected" : ""}`}
                        key={i.id}
                        onClick={() => setSelected(i.id)}
                      >
                        <Icon name="extraction" />
                        <span>
                          {i.title}
                          <small>
                            {i.receipt
                              ? i.receipt.decision
                              : `${i.format.toUpperCase()} · ${i.source.length} regions`}
                          </small>
                        </span>
                        <Icon name="next" size={14} />
                      </button>
                    ))}
                </section>
              ))}
            </div>
          </aside>
          {item ? (
            <>
              <Evidence item={item} />
              <Judgment item={item} onSaved={refresh} onNext={next} />
            </>
          ) : (
            <main className="empty">
              <h1>No items in this queue</h1>
              <p>
                Run or resume the corpus pipeline to prepare source-bound review
                items.
              </p>
            </main>
          )}
        </>
      )}
      <footer>
        <span className="local-dot" />
        Local review<span className="separator">·</span>Decisions saved to this
        run.
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
