import { describe, expect, it } from "vitest";
import { createOllamaClient, validateClassify } from "./ollama.js";

describe("validateClassify", () => {
  it("accepts valid payload", () => {
    expect(
      validateClassify({
        category: "Finance",
        subcategory: "Taxes",
        confidence: 0.8,
        rationale: "headers look fiscal",
      }),
    ).toEqual({
      category: "Finance",
      subcategory: "Taxes",
      confidence: 0.8,
      rationale: "headers look fiscal",
    });
  });

  it("rejects garbage", () => {
    expect(() => validateClassify("nope")).toThrow(/non-JSON object/);
    expect(() => validateClassify({ confidence: 1 })).toThrow(/missing category/);
  });
});

describe("local image analysis", () => {
  it("sends image bytes to the requested Ollama vision model", async () => {
    let sent: Record<string, unknown> | undefined;
    const client = createOllamaClient({
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ response: JSON.stringify({ description: "A pair of dumbbells." }) }));
      },
    });

    const description = await client.describeImage({
      model: "qwen2.5vl:7b",
      filename: "dumbbells.png",
      imageBase64: "local-base64",
    });

    expect(sent?.model).toBe("qwen2.5vl:7b");
    expect(sent?.images).toEqual(["local-base64"]);
    expect(description).toBe("A pair of dumbbells.");
  });
});
