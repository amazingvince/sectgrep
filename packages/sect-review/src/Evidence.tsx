import { useEffect, useState, useRef } from "react";
import { download, request, type Item } from "./api";

export function Evidence({ item }: { item: Item }) {
  const [index, setIndex] = useState(0);
  const [locationIndex, setLocationIndex] = useState(0);
  const [tab, setTab] = useState("source");
  const [image, setImage] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  const [catalog, setCatalog] = useState<{
    total: number;
    regions: Array<{
      id: string;
      text: string;
      title: string;
      revision: string;
      locator: Item["source"][number]["locator"];
    }>;
  }>({ total: 0, regions: [] });
  const [region, setRegion] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const chosen = catalog.regions.find((r) => r.id === region);
  const source =
    chosen && item.source[index]
      ? { ...item.source[index], text: chosen.text, locator: chosen.locator }
      : item.source[index];
  const locations = source?.locator.type === "pages" ? source.locator.locations ?? [] : source ? [source.locator] : [];
  const location = locations[locationIndex] ?? locations[0];
  const selectedLocation = locations[locationIndex] ? locationIndex : 0;
  const pane = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ width: 1, height: 1 });
  useEffect(() => {
    setIndex(0);
    setLocationIndex(0);
    setTab("source");
    setQuery("");
    setOffset(0);
    setRegion("");
    setCatalog({ total: 0, regions: [] });
  }, [item.id]);
  useEffect(() => {
    if (item.kind !== "benchmark" || !item.source.length) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      request(
        `/api/catalog?item=${encodeURIComponent(item.id)}&index=${index}&offset=${offset}&q=${encodeURIComponent(query)}`,
      )
        .then((r) => r.json())
        .then((data) => {
          if (!cancelled) {
            setCatalog(data);
            setRegion(data.regions[0]?.id ?? "");
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [item.id, index, query, offset]);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setImage(null);
    setRaw("");
    setError("");
    if (!source) return;
    request(
      `/api/source?item=${encodeURIComponent(item.id)}&index=${index}&location=${selectedLocation}${chosen ? `&region=${encodeURIComponent(chosen.id)}` : ""}`,
    )
      .then(async (response) => {
        if (response.headers.get("content-type")?.startsWith("image/")) {
          objectUrl = URL.createObjectURL(await response.blob());
          if (!cancelled) {
            setGeometry({
              width: Number(response.headers.get("x-page-width")),
              height: Number(response.headers.get("x-page-height")),
            });
            setImage(objectUrl);
          }
        } else {
          const data = await response.json();
          let text = data.raw ?? data.text ?? "";
          if (source.locator.type === "xml" || source.locator.type === "office" || item.format === "html") {
            const dom = new DOMParser().parseFromString(
              text,
              /\.html?$/i.test(source.file) ? "text/html" : "text/xml",
            );
            if (source.locator.type === "xml" || source.locator.type === "office")
              try {
                const node = dom.evaluate(
                  String(source.locator.xpath),
                  dom,
                  null,
                  XPathResult.FIRST_ORDERED_NODE_TYPE,
                  null,
                ).singleNodeValue;
                text = node
                  ? new XMLSerializer().serializeToString(node)
                  : text;
              } catch {
                /* Retain the original source when namespace-aware lookup is unavailable. */
              }
            else {
              dom
                .querySelectorAll("script,style,nav,header,footer")
                .forEach((e) => e.remove());
              text = dom.body?.textContent ?? text;
            }
          }
          const start = source.text ? text.indexOf(source.text) : -1;
          if (start >= 0)
            text = text.slice(
              Math.max(0, start - 1200),
              start + source.text.length + 1200,
            );
          if (!cancelled) setRaw(text);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.id, index, source?.file, chosen?.id, selectedLocation]);
  return (
    <section className="evidence" aria-label="Source evidence">
      <div className="evidence-heading">
        <h2>Source evidence</h2>
        <label>
          {item.kind === "benchmark" ? "Document" : "Region"}{" "}
          <select
            aria-label="Region"
            value={index}
            onChange={(e) => {
              setIndex(Number(e.target.value));
              setLocationIndex(0);
              setRegion("");
              setCatalog({ total: 0, regions: [] });
              setOffset(0);
            }}
          >
            {item.source.map((s, i) => (
              <option key={i} value={i}>
                {item.kind === "benchmark"
                  ? s.file.split(/[\\/]/).at(-1)
                  : `${i + 1}${s.locator.page ? ` · Page ${s.locator.page}` : ""}`}
              </option>
            ))}
          </select>{" "}
          / {item.source.length}
        </label>
      </div>
      {item.kind === "benchmark" && item.source.length > 0 && (
        <div className="catalog">
          <input
            aria-label="Find text in source"
            placeholder="Find text in this source"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
          <select
            aria-label="Source section"
            value={region}
            onChange={(e) => { setRegion(e.target.value); setLocationIndex(0); }}
          >
            {catalog.regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title} · {r.text.slice(0, 70)}
              </option>
            ))}
          </select>
          <div className="pagination">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 100))}
            >
              Previous regions
            </button>
            <span>
              {Math.min(offset + 1, catalog.total)}–
              {Math.min(offset + 100, catalog.total)} / {catalog.total}
            </span>
            <button
              disabled={offset + 100 >= catalog.total}
              onClick={() => setOffset(offset + 100)}
            >
              Next regions
            </button>
          </div>
          <code>{chosen?.revision}</code>
          {chosen && (
            <button
              className="text-button"
              onClick={() =>
                navigator.clipboard
                  .writeText(chosen.revision)
                  .catch((e) => setError(String(e)))
              }
            >
              Copy revision ID
            </button>
          )}
        </div>
      )}
      <div className="tabs">
        <button
          className={tab === "source" ? "selected" : ""}
          onClick={() => setTab("source")}
        >
          Source
        </button>
        <button
          className={tab === "structure" ? "selected" : ""}
          onClick={() => setTab("structure")}
        >
          Structure
        </button>
      </div>
      <div className="locator">
        Locator{" "}
        <code>
          {source ? JSON.stringify(source.locator) : "No source selected"}
        </code>
      </div>
      {locations.length > 1 && <label>Source box <select aria-label="Source box" value={selectedLocation} onChange={e => setLocationIndex(Number(e.target.value))}>
        {locations.map((l, i) => <option key={i} value={i}>{i + 1} · Page {l.page}</option>)}
      </select> The excerpt spans all {locations.length} boxes; text alignment within each box is unverified.</label>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {tab === "source" ? (
        <>
          <div ref={pane} className={`source-page ${image ? "pdf" : ""}`}>
            {image ? (
              <div className="page-image">
                <img
                  src={image}
                  alt={`Original source page ${location?.page}`}
                  onLoad={() => {
                    if (pane.current && location?.bbox)
                      pane.current.scrollTop = Math.max(
                        0,
                        (location.bbox[1] * pane.current.clientWidth) /
                          geometry.width -
                          100,
                      );
                  }}
                />
                {location?.bbox && geometry.width > 1 && (
                  <div
                    className="source-highlight"
                    style={{
                      left: `${(100 * location.bbox[0]) / geometry.width}%`,
                      top: `${(100 * location.bbox[1]) / geometry.height}%`,
                      width: `${(100 * (location.bbox[2] - location.bbox[0])) / geometry.width}%`,
                      height: `${(100 * (location.bbox[3] - location.bbox[1])) / geometry.height}%`,
                    }}
                  />
                )}
              </div>
            ) : (
              <pre>
                {raw ||
                  (source
                    ? "Loading source…"
                    : "Source access is unavailable for this locked task.")}
              </pre>
            )}
          </div>
          <h3>Exact source excerpt</h3>
          <blockquote>{source?.text}</blockquote>
        </>
      ) : (
        <div className="structure">
          <h3>
            {item.kind === "benchmark"
              ? "Source location"
              : "Structure and proposal"}
          </h3>
          <pre>
            {JSON.stringify(
              item.kind === "benchmark"
                ? source?.locator
                : (item.proposal ?? source?.locator),
              null,
              2,
            )}
          </pre>
        </div>
      )}
      <p className="source-foot">From: {source?.file.split(/[\\/]/).at(-1)}</p>
      {source && (
        <button
          className="text-button"
          onClick={async () => {
            try {
              const r = await request(
                `/api/source?item=${encodeURIComponent(item.id)}&index=${index}&download=1`,
              );
              download(await r.blob(), source.file.split(/[\\/]/).at(-1)!);
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          Download original
        </button>
      )}
    </section>
  );
}
