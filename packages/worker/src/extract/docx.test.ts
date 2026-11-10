import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { extractDocx } from "./docx.js";
import { extractPptx } from "./pptx.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

async function writeMinimalDocx(file: string, text: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.folder("_rels")!.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder("word")!.file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`,
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(file, buf);
}

async function writeMinimalPptx(file: string, text: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
  );
  zip.folder("ppt")!.folder("slides")!.file(
    "slide1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`,
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(file, buf);
}

describe("extractDocx", () => {
  it("reads text sample", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-docx-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "t.docx");
    await writeMinimalDocx(file, "Contract renewal Q3");
    const result = await extractDocx(file);
    expect(result.summary.kind).toBe("docx");
    expect(String(result.summary.text)).toContain("Contract renewal Q3");
  });
});

describe("extractPptx", () => {
  it("reads slide text", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "untangle-pptx-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "t.pptx");
    await writeMinimalPptx(file, "Kickoff agenda");
    const result = await extractPptx(file);
    expect(result.summary.kind).toBe("pptx");
    expect(String(result.summary.text)).toContain("Kickoff agenda");
  });
});
