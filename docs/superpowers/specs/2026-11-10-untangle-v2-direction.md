# Untangle V2 direction: content-first topic organization

**Date:** 2026-11-10  
**Status:** Product direction; V2 implementation in progress

## Intent

Make Untangle organize a messy file collection by what files contain, finding related material across file types and scan batches. The user should not need to build the topic map manually. Untangle proposes destinations and keeps its existing approval-before-move safety rule.

## Product promise

“Untangle reads what it can from your files, groups related material into coherent topics, and asks before moving anything.”

## Responsibilities

- **Scanner and extractors:** Read supported file contents and produce compact, structured evidence. Never send whole files to the model or store full documents in SQLite.
- **Ollama:** Act as the local topic analyst. Compare extracted evidence, identify related files, reuse or propose topic categories, and return structured suggestions with rationale. It does not read files, maintain filesystem state, or move files.
- **Untangle worker:** Maintain the shared topic taxonomy across file types and scan batches, validate model output, prepare destination proposals, and execute only user-approved moves.

The model’s disk size is an installation/runtime constraint, not a product responsibility. Ollama remains an optional local service; its configured model performs analysis based on the evidence and context Untangle supplies.

## V2 goals

- Group semantically related files across extensions and separate scan batches.
- Make extraction coverage explicit by file type; prioritize useful content evidence over filename-only classification.
- Reuse stable shared topics using more context than category names alone (for example, concise topic descriptions and representative evidence).
- Make low-evidence or unreadable files distinguishable from content-grounded suggestions.
- Keep analysis local, bounded, resumable, and compatible with the approval and move journal.

## Non-goals

- Sending full file contents to Ollama or a cloud service.
- Silent or bulk moves without the existing approval safeguards.
- Requiring users to manually draw or maintain a topic map.
- Assuming every format can be deeply understood; unsupported or encrypted files must be handled honestly.

## Directional pipeline

1. Inventory files and extract compact evidence using format-specific extractors.
2. Analyze evidence in bounded work units while retaining a shared, persistent topic context across units and file types.
3. Assign files to existing topics or propose new ones; include rationale and evidence quality.
4. Validate suggestions, produce paths, and request approval before moves.

The V1 batch analyst is a useful stepping stone, but a batch-local grouping call alone does not meet the V2 goal: related files can be in different batches or queues. V2 must connect batch analysis to persistent library-wide topic context. Embeddings, OCR, and additional extractors are implementation options to evaluate against actual quality and local resource limits, not assumptions of this direction.

## Acceptance direction

- Related readable files with dissimilar names are grouped under the same shared topic even when they have different extensions or are processed in different batches.
- A file with only metadata evidence is not presented as if its contents were understood.
- Model failure or malformed output cannot trigger a move; the worker falls back safely and retains reviewability.
- The user still approves each proposed move, with a clear reason for the suggestion.

## Open design work

- Define how shared topic context is stored, updated, and versioned.
- Choose bounded cross-batch analysis strategy and model context budget.
- Prioritize extractors (including OCR/media) based on expected value, accuracy, and local compute cost.
- Define evaluation corpus and measures for grouping quality, category stability, and extraction coverage.
