import { describe, expect, it } from "vitest";
import { TYPE_ORDER, extToQueueType } from "./type-order.js";

describe("TYPE_ORDER", () => {
  it("starts with xlsx then docx pdf pptx images videos other", () => {
    expect(TYPE_ORDER).toEqual([
      "xlsx",
      "docx",
      "pdf",
      "pptx",
      "images",
      "videos",
      "other",
    ]);
  });
});

describe("extToQueueType", () => {
  it("maps office and media extensions", () => {
    expect(extToQueueType(".XLSX")).toBe("xlsx");
    expect(extToQueueType("docx")).toBe("docx");
    expect(extToQueueType(".pdf")).toBe("pdf");
    expect(extToQueueType(".PPTX")).toBe("pptx");
    expect(extToQueueType(".jpg")).toBe("images");
    expect(extToQueueType(".png")).toBe("images");
    expect(extToQueueType(".mp4")).toBe("videos");
    expect(extToQueueType(".mov")).toBe("videos");
    expect(extToQueueType(".zip")).toBe("other");
  });
});
