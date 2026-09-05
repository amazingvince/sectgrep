import JSZip from "jszip";

/** Matches the Rust Office package-member contract; a package part is never a filesystem path. */
export function validOfficeLocator(part: string, xpath: string): boolean {
  return !!part && part.endsWith(".xml") && xpath.startsWith("/") &&
    !/[\\:\p{Cc}]/u.test(part) &&
    part.split("/").every(p => !!p && p !== "." && p !== "..");
}

/** Read an original package part for source inspection. Does not extract files or execute markup. */
export async function readOfficeXml(buffer: Buffer, part: string): Promise<string> {
  if (!validOfficeLocator(part, "/")) throw new Error("invalid Office source part");
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(part);
  if (!file) throw new Error("Office source part is absent");
  return file.async("string");
}

export function validPageLocation(l: { page: number; bbox?: number[] | null }): boolean {
  return Number.isInteger(l.page) && l.page > 0 && (!l.bbox ||
    l.bbox.length === 4 && l.bbox.every(Number.isFinite) && l.bbox[0] <= l.bbox[2] && l.bbox[1] <= l.bbox[3]);
}
