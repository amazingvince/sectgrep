import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewStore, type Decision } from "./review.js";
import { hash, safePath, atomic, json } from "./io.js";
import { renderPage } from "@sectgrep/convert/render";
import { RetrievalInspector } from "./retrieval.js";
import { readOfficeXml } from "@sectgrep/convert/document";

export async function startReviewServer(run: string, port = 0) {
  run = path.resolve(run);
  const store = new ReviewStore(run);
  const inspector = existsSync(safePath(run, "retrieval.json"))
    ? new RetrievalInspector(run)
    : null;
  const token = randomBytes(32).toString("hex");
  const web = fileURLToPath(
    new URL("../../../sect-review/dist/", import.meta.url),
  );
  if (!existsSync(path.join(web, "index.html")))
    throw new Error(
      "review application is not built; run pnpm --filter @sectgrep/review build",
    );
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin)
      )
        return send(403, { error: "loopback origin required" });
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      const url = new URL(req.url ?? "/", origin);
      if (url.pathname.startsWith("/api/")) {
        const supplied = String(req.headers["x-sect-token"] ?? "");
        if (
          supplied.length !== token.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        )
          return send(403, { error: "review session token required" });
        if (
          inspector &&
          req.method === "GET" &&
          url.pathname.startsWith("/api/retrieval")
        ) {
          if (url.pathname === "/api/retrieval")
            return send(200, inspector.metadata());
          if (url.pathname === "/api/retrieval/search")
            return send(
              200,
              await inspector.search(url.searchParams.get("q") ?? ""),
            );
          if (url.pathname === "/api/retrieval/passage")
            return send(
              200,
              inspector.passage(url.searchParams.get("id") ?? ""),
            );
          if (url.pathname === "/api/retrieval/source") {
            const source = await inspector.source(
              url.searchParams.get("expr") ?? "",
              url.searchParams.has("page")
                ? Number(url.searchParams.get("page"))
                : undefined,
            );
            res.writeHead(200, {
              "Content-Type": source.mime,
              "Cache-Control": "no-store",
            });
            return res.end(source.bytes);
          }
        }
        if (url.pathname === "/api/items" && req.method === "GET") {
          const items = store.items().map((item) => {
            try {
              store.assertAccessible(item);
            } catch {
              return {
                ...item,
                proposal: undefined,
                prompt:
                  "Held-out task locked until tuning judgments, topic-overlap review and recipe freeze are complete.",
                source: [],
                bindings: {},
                locked: true,
              };
            }
            // Benchmark mode never ships model answers, proposed evidence, rankings or ranker names.
            if (item.kind === "benchmark") {
              const { proposal, ...blind } = item;
              return blind;
            }
            return item;
          });
          return send(200, {
            name: existsSync(path.join(run, "identity.json"))
              ? json<{ name: string }>(path.join(run, "identity.json")).name
              : path.basename(run),
            items,
            retrieval: !!inspector,
          });
        }
        if (url.pathname === "/api/export" && req.method === "GET")
          return send(200, store.export());
        if (url.pathname === "/api/catalog" && req.method === "GET") {
          const item = store.get(url.searchParams.get("item") ?? "");
          store.assertAccessible(item);
          store.assertFresh(item);
          const index = Number(url.searchParams.get("index") ?? 0),
            offset = Number(url.searchParams.get("offset") ?? 0);
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            !Number.isInteger(offset) ||
            offset < 0
          )
            throw new Error("invalid catalog page");
          const document = store.sourceDocument(item, index);
          if (!document)
            return send(404, { error: "source structure unavailable" });
          const query = (url.searchParams.get("q") ?? "").toLowerCase();
          const units = new Map(
            document.units.flatMap((u) =>
              u.regions.map((id) => [
                id,
                { revision: `${u.id}@${document.effective}`, title: u.title },
              ]),
            ),
          );
          const matches = document.regions.filter(
            (r) =>
              !r.exclusion && (!query || r.text.toLowerCase().includes(query)),
          );
          return send(200, {
            total: matches.length,
            regions: matches
              .slice(offset, offset + 100)
              .map((r) => ({ ...r, ...units.get(r.id) })),
          });
        }
        if (url.pathname === "/api/decision" && req.method === "POST") {
          if (!req.headers["content-type"]?.startsWith("application/json"))
            return send(415, { error: "JSON required" });
          let bytes = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 256000)
              return send(413, { error: "decision too large" });
            chunks.push(chunk);
          }
          return send(
            200,
            store.decide(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as Decision,
            ),
          );
        }
        if (url.pathname === "/api/source" && req.method === "GET") {
          const item = store.get(url.searchParams.get("item") ?? "");
          store.assertAccessible(item);
          store.assertFresh(item);
          const index = Number(url.searchParams.get("index") ?? "0");
          let source = item.source[index];
          if (!source) return send(404, { error: "unknown source" });
          if (url.searchParams.has("region")) {
            const region = store
              .sourceDocument(item, index)
              ?.regions.find((r) => r.id === url.searchParams.get("region"));
            if (!region) return send(404, { error: "unknown source region" });
            source = { ...source, locator: region.locator, text: region.text };
          }
          const raw = readFileSync(
            safePath(path.dirname(source.file), path.basename(source.file)),
          );
          if (hash(raw) !== source.sha256)
            return send(409, { error: "source bytes changed" });
          if (url.searchParams.get("download") === "1") {
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename="${path.basename(source.file).replaceAll('"', "")}"`,
            });
            return res.end(raw);
          }
          const locationIndex = Number(url.searchParams.get("location") ?? "0");
          const locations = source.locator.type === "pages" ? source.locator.locations : [source.locator];
          if (!Number.isInteger(locationIndex) || !locations[locationIndex]) return send(404, { error: "unknown source location" });
          const pageLocation = source.locator.type === "pages" ? source.locator.locations[locationIndex]
            : source.locator.type === "page" ? source.locator : undefined;
          if (source.locator.type === "office") return send(200, {
            type: "text", raw: await readOfficeXml(raw, source.locator.part), locator: source.locator,
            source_view: "Original Office XML part; page rendering is unavailable.",
          });
          if (
            path.extname(source.file).toLowerCase() === ".pdf" &&
            pageLocation
          ) {
            const page = pageLocation.page;
            const cache = safePath(
              run,
              `page-images/${source.sha256}-${page}.png`,
            );
            if (!existsSync(cache) || !existsSync(cache + ".json")) {
              const rendered = await renderPage(source.file, page);
              mkdirSync(path.dirname(cache), { recursive: true });
              writeFileSync(cache, rendered.png);
              atomic(cache + ".json", {
                width: (rendered.widthPx * 72) / rendered.dpi,
                height: (rendered.heightPx * 72) / rendered.dpi,
              });
            }
            const geometry = json<{ width: number; height: number }>(
              cache + ".json",
            );
            res.writeHead(200, {
              "Content-Type": "image/png",
              "Cache-Control": "private, max-age=3600",
              "X-Page-Width": geometry.width,
              "X-Page-Height": geometry.height,
            });
            return res.end(readFileSync(cache));
          }
          const ext = path.extname(source.file).toLowerCase();
          if (
            [
              ".html",
              ".htm",
              ".xml",
              ".txt",
              ".md",
              ".json",
              ".csv",
              ".tsv",
            ].includes(ext)
          )
            return send(200, {
              type: "text",
              raw: raw.toString("utf8"),
              locator: source.locator,
            });
          return send(200, {
            type: "structured",
            locator: source.locator,
            text: source.text,
            notice:
              "Native sheet/slide locator. Download the original for an independent visual check.",
          });
        }
        return send(404, { error: "unknown review operation" });
      }
      if (req.method !== "GET")
        return send(405, { error: "method not allowed" });
      const relative =
        url.pathname === "/"
          ? "index.html"
          : decodeURIComponent(url.pathname.slice(1));
      const file = safePath(web, relative);
      if (!existsSync(file)) return send(404, { error: "not found" });
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
      };
      res.writeHead(200, {
        "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(readFileSync(file));
    } catch (error) {
      send(400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  server.once("close", () => store.close());
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/#${token}`,
  };
}
