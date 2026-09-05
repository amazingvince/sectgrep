import { describe, expect, it } from "vitest";
import { agrees } from "../src/ocr/dual.js";

describe("review: OCR preserves protected content", () => {
  it.each([["1.0 mm", "10 mm"], ["1,0 mm", "10 mm"], ["-10 mm", "10 mm"], ["≤ 10 mm", "< 10 mm"], ["shall not permit", "shall permit"]])("rejects %s versus %s", (a, b) => {
    expect(agrees(`The limit shall be ${a}.`, `The limit shall be ${b}.`)).toBe(false);
  });
});
