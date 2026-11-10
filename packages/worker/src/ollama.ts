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
      "- REUSE an existing category when the topic is related (Election Statistics and Election Turnout → category Election or the existing Election* folder).",
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

  return { status, classify };
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
