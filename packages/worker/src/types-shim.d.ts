declare module "mammoth" {
  export function extractRawText(input: {
    path: string;
  }): Promise<{ value: string }>;
}

declare module "pdf-parse" {
  function pdfParse(buf: Buffer): Promise<{
    text: string;
    numpages: number;
    info?: Record<string, unknown>;
  }>;
  export = pdfParse;
}
