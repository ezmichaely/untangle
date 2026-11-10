import type { OllamaStatus } from "@untangle/shared";

export interface OllamaClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ClassifyInput {
  model: string;
  summary: Record<string, unknown>;
  categories: string[];
  filename: string;
}

export interface ClassifyOutput {
  category: string;
  subcategory?: string;
  confidence: number;
  rationale: string;
}

export interface DescribeImageInput {
  model: string;
  filename: string;
  imageBase64: string;
}

export type EvidenceQuality = "content" | "metadata";

export interface BatchAnalyzeFile {
  id: number;
  queueType: string;
  filename: string;
  summary: Record<string, unknown>;
  evidenceQuality: EvidenceQuality;
}

export interface TopicContext {
  category: string;
  description: string;
  examples: Array<{ id?: number; filename: string; queueType: string; summary: string }>;
}

export interface BatchAnalyzeInput {
  model: string;
  files: BatchAnalyzeFile[];
  topics: TopicContext[];
}

export interface BatchAnalyzeGroup {
  category: string;
  subcategory?: string;
  fileIds: number[];
  confidence: number;
  rationale: string;
  evidenceQuality: EvidenceQuality;
}

export interface BatchAnalyzeOutput {
  groups: BatchAnalyzeGroup[];
}

export function createOllamaClient(opts: OllamaClientOptions = {}) {
  const baseUrl = opts.baseUrl ?? "http://127.0.0.1:11434";
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function status(model: string): Promise<OllamaStatus> {
    try {
      const res = await fetchImpl(`${baseUrl}/api/tags`);
      if (!res.ok) {
        return { ok: false, model, error: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as {
        models?: Array<{ name: string }>;
      };
      const names = (body.models ?? []).map((m) => m.name);
      const present = names.some(
        (n) => n === model || n.startsWith(`${model}:`) || n.startsWith(model),
      );
      return present
        ? { ok: true, model }
        : {
            ok: false,
            model,
            error: names.length
              ? `model not found; have: ${names.join(", ")}`
              : "no models installed",
          };
    } catch (err) {
      return {
        ok: false,
        model,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function classify(input: ClassifyInput): Promise<ClassifyOutput> {
    const prompt = [
      "You name folders for a personal file organizer.",
      "Return ONLY valid JSON: {\"category\":string,\"subcategory\":string|null,\"confidence\":0-1,\"rationale\":string}",
      "Rules:",
      "- category = SHORT topic folder, 1-2 words (e.g. Election, Finance, HR). Never a long sentence.",
      "- Put specifics in subcategory (e.g. Voter Turnout, Q3 Budget).",
      "- Choose a category from this file's subject; reuse an existing category only when it clearly has the same subject.",
      "- Existing categories are optional hints, not defaults. Never force an unrelated file into one; create a new category when needed.",
      "- Never glue words together (wrong: Election StatisticsVoter). Use spaces.",
      "- Prefer existing list over inventing new roots.",
      `Existing top-level folders: ${JSON.stringify(input.categories)}`,
      `Filename: ${input.filename}`,
      `Summary: ${JSON.stringify(input.summary)}`,
    ].join("\n");

    const res = await fetchImpl(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0.1 },
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama generate failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { response?: string };
    const raw = body.response ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Ollama returned non-JSON");
    }
    return validateClassify(parsed);
  }

  async function describeImage(input: DescribeImageInput): Promise<string> {
    const prompt = [
      "Describe the visible objects and context in this image for accurate file organization.",
      "Do not guess from its filename. Mention only details visible in the image.",
      "Return ONLY JSON: {\"description\":string}",
      `Filename for reference only: ${input.filename}`,
    ].join("\n");
    const res = await fetchImpl(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        prompt,
        images: [input.imageBase64],
        stream: false,
        format: "json",
        options: { temperature: 0.1 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama image analysis failed: HTTP ${res.status}`);
    const body = (await res.json()) as { response?: string };
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.response ?? "");
    } catch {
      throw new Error("Ollama returned non-JSON image description");
    }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as Record<string, unknown>).description !== "string") {
      throw new Error("Ollama returned invalid image description");
    }
    const description = (parsed as { description: string }).description.trim();
    if (!description) throw new Error("Ollama returned an empty image description");
    return description.slice(0, 700);
  }

  async function analyzeBatch(
    input: BatchAnalyzeInput,
  ): Promise<BatchAnalyzeOutput> {
    const prompt = [
      "You are a local topic analyst for a personal file organizer.",
      'Return ONLY JSON: {"groups":[{"category":string,"subcategory":string|null,"fileIds":number[],"confidence":number,"rationale":string,"evidenceQuality":"content"|"metadata"}]}',
      "Rules:",
      "- Decide each file's subject from that file's own summary first, then group only files with a clear shared subject.",
      "- Existing topic context is only a hint. Reuse a topic only when the file evidence clearly supports that same subject; otherwise create a new short category.",
      "- Never place a file in a topic just to reuse a folder, based on a broad word, filename coincidence, or file type.",
      "- For metadata-only evidence, use the filename cautiously, lower confidence, and do not claim to understand file contents.",
      "- Every submitted file ID must occur exactly once across all groups. Do not invent IDs.",
      "- Use evidenceQuality=content only when file contents support the grouping; metadata means the evidence is only a name or file metadata.",
      "- Keep category short (1-2 words), specifics in subcategory, and rationale concise.",
      `Existing topic context: ${JSON.stringify(input.topics.map(({ category, description, examples }) => ({
        category,
        description,
        examples: examples.map(({ filename, queueType, summary }) => ({ filename, queueType, summary })),
      })))}`,
      `Files: ${JSON.stringify(input.files)}`,
    ].join("\n");
    const res = await fetchImpl(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0.1 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama generate failed: HTTP ${res.status}`);
    const body = (await res.json()) as { response?: string };
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.response ?? "");
    } catch {
      throw new Error("Ollama returned non-JSON");
    }
    return validateBatchAnalyze(parsed, input.files.map((file) => file.id));
  }

  return { status, classify, describeImage, analyzeBatch };
}

export function validateBatchAnalyze(
  parsed: unknown,
  expectedIds: number[],
): BatchAnalyzeOutput {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Ollama returned invalid batch groups");
  }
  const rawGroups = (parsed as Record<string, unknown>).groups;
  if (!Array.isArray(rawGroups)) throw new Error("Ollama returned invalid batch groups");
  const expected = new Set(expectedIds);
  const seen = new Set<number>();
  const groups = rawGroups.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("invalid batch group");
    const group = raw as Record<string, unknown>;
    if (typeof group.category !== "string" || !group.category.trim()) {
      throw new Error("batch group missing category");
    }
    if (!Array.isArray(group.fileIds) || group.fileIds.length === 0) {
      throw new Error("batch group missing file IDs");
    }
    const fileIds = group.fileIds.map((id) => {
      if (typeof id !== "number" || !Number.isInteger(id) || !expected.has(id)) {
        throw new Error("batch group contains unknown file ID");
      }
      if (seen.has(id)) throw new Error("batch group contains duplicate file ID");
      seen.add(id);
      return id;
    });
    const confidence = group.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("batch group has invalid confidence");
    }
    if (typeof group.rationale !== "string") throw new Error("batch group missing rationale");
    if (group.evidenceQuality !== "content" && group.evidenceQuality !== "metadata") {
      throw new Error("batch group has invalid evidence quality");
    }
    if (group.subcategory !== undefined && group.subcategory !== null && typeof group.subcategory !== "string") {
      throw new Error("batch group has invalid subcategory");
    }
    return {
      category: group.category.trim(),
      subcategory: typeof group.subcategory === "string" && group.subcategory.trim()
        ? group.subcategory.trim()
        : undefined,
      fileIds,
      confidence,
      rationale: group.rationale,
      evidenceQuality: group.evidenceQuality,
    } satisfies BatchAnalyzeGroup;
  });
  if (seen.size !== expected.size || [...expected].some((id) => !seen.has(id))) {
    throw new Error("batch groups do not cover every file ID");
  }
  return { groups };
}

export function validateClassify(parsed: unknown): ClassifyOutput {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Ollama returned non-JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.category !== "string" || !o.category.trim()) {
    throw new Error("missing category");
  }
  const confidence =
    typeof o.confidence === "number" && Number.isFinite(o.confidence)
      ? Math.min(1, Math.max(0, o.confidence))
      : 0.5;
  return {
    category: o.category.trim(),
    subcategory:
      typeof o.subcategory === "string" && o.subcategory.trim()
        ? o.subcategory.trim()
        : undefined,
    confidence,
    rationale: typeof o.rationale === "string" ? o.rationale : "",
  };
}
