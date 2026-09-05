export interface Item {
  locked?: boolean;
  id: string;
  item_sha256: string;
  kind: string;
  document: string;
  domain: string;
  format: string;
  title: string;
  prompt: string;
  batch: number;
  lot?: string;
  source: {
    file: string;
    sha256: string;
    text: string;
    locator: {
      type: string;
      page?: number;
      bbox?: number[] | null;
      locations?: { page: number; bbox: number[] | null; elements: number[] }[];
      [key: string]: unknown;
    };
  }[];
  proposal?: unknown;
  receipt: {
    decision: string;
    reviewer: string;
    reason: string;
    sha256: string;
  } | null;
}
const token =
  location.hash.slice(1) || sessionStorage.getItem("sect-token") || "";
if (token) sessionStorage.setItem("sect-token", token);
history.replaceState(null, "", location.pathname);
export async function request(url: string, body?: unknown): Promise<Response> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "x-sect-token": token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }
  return response;
}
export async function getItems(): Promise<{ name: string; items: Item[]; retrieval?:boolean }> {
  return (await request("/api/items")).json();
}
export async function exportDecisions() {
  const response = await request("/api/export");
  download(await response.blob(), "sect-review-decisions.json");
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
