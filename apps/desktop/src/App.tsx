import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRightIcon,
  CheckIcon,
  FolderOpenIcon,
  SkipForwardIcon,
  SparklesIcon,
  Undo2Icon,
} from "lucide-react";
import {
  TYPE_ORDER,
  type ActionView,
  type InventoryCounts,
  type OllamaStatus,
  type ProposalView,
  type QueueType,
  type RootsConfig,
  type VersionGroupView,
} from "@untangle/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Step = 1 | 2 | 3 | 4 | 5;

const TYPE_LABELS: Record<QueueType, string> = {
  xlsx: "Spreadsheets (Excel)",
  docx: "Word documents",
  pdf: "PDF files",
  pptx: "Presentations",
  images: "Photos & images",
  videos: "Videos",
  other: "Other files",
};

const STEPS: Array<{ id: Step; title: string; blurb: string }> = [
  {
    id: 1,
    title: "Choose folders",
    blurb: "Where are the messy files, and where should clean ones go?",
  },
  {
    id: 2,
    title: "Find files",
    blurb: "Untangle looks through the messy folder and makes a list.",
  },
  {
    id: 3,
    title: "Suggest places",
    blurb: "Pick one file type. Untangle suggests folders for those files.",
  },
  {
    id: 4,
    title: "Approve moves",
    blurb: "You decide. Nothing moves until you say yes.",
  },
  {
    id: 5,
    title: "Clean duplicates",
    blurb: "If the same file appears more than once, keep one copy.",
  },
];

async function api<T>(
  command: Parameters<Window["untangle"]["call"]>[0],
): Promise<T> {
  if (!window.untangle) {
    throw new Error(
      "Please open Untangle from the desktop app (not a browser).",
    );
  }
  return window.untangle.call(command) as Promise<T>;
}

function shortName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function joinDest(cleanRoot: string | undefined, rel: string): string {
  if (!cleanRoot) return rel;
  const root = cleanRoot.replace(/[/\\]+$/, "");
  const sep = cleanRoot.includes("\\") ? "\\" : "/";
  return `${root}${sep}${rel.replace(/\\/g, "/").replace(/\//g, sep)}`;
}

function confidenceLabel(confidence: number): {
  text: string;
  tone: "default" | "secondary" | "outline";
} {
  if (confidence >= 0.85) return { text: "Looks sure", tone: "default" };
  if (confidence >= 0.55) return { text: "Pretty sure", tone: "secondary" };
  return { text: "Best guess", tone: "outline" };
}

function reasonFor(proposal: ProposalView): string {
  const evidence = proposal.evidence as Record<string, unknown> | null;
  if (!evidence || typeof evidence !== "object") {
    return "Suggested from the file contents.";
  }
  const rule = evidence.rule;
  if (rule === "exact_sha256_duplicate") {
    return "This is an exact copy of a file you already organized.";
  }
  if (rule === "fingerprint_match") {
    return "This looks very similar to a file you already organized.";
  }
  if (typeof evidence.rationale === "string" && evidence.rationale.trim()) {
    return evidence.rationale.trim();
  }
  if (rule === "ollama") {
    return "Suggested by the helper AI from the file summary.";
  }
  return "Suggested from the file contents.";
}

export function App() {
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "info" | "success" | "error";
    title: string;
    body: string;
  } | null>({
    tone: "info",
    title: "Welcome",
    body: "Start with step 1 — choose your folders.",
  });
  const [error, setError] = useState<string | null>(null);

  const [messy, setMessy] = useState("");
  const [untangle, setUntangle] = useState("");
  const [roots, setRootsState] = useState<RootsConfig | null>(null);
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [inventory, setInventory] = useState<InventoryCounts | null>(null);
  const [queueType, setQueueType] = useState<QueueType>("xlsx");
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [actions, setActions] = useState<ActionView[]>([]);
  const [versions, setVersions] = useState<VersionGroupView[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [destEdit, setDestEdit] = useState("");
  const [batchTotal, setBatchTotal] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const r = await api<RootsConfig | null>({ type: "getRoots" });
      setRootsState(r);
      if (r) {
        setMessy(r.messyPath);
        setUntangle(r.untanglePath);
      }
      setInventory(await api<InventoryCounts>({ type: "getInventory" }));
      setProposals(await api<ProposalView[]>({ type: "listProposals" }));
      setActions(await api<ActionView[]>({ type: "listActions", limit: 20 }));
      setOllama(await api<OllamaStatus>({ type: "ollamaStatus" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const foldersReady = !!(roots?.messyPath && roots?.untanglePath);
  const filesFound = (inventory?.total ?? 0) > 0;
  const hashedReady =
    filesFound && inventory !== null && inventory.hashed >= inventory.total;
  const hasProposals = proposals.length > 0;
  const hasMoves = actions.some((a) => !a.undone && a.kind === "move");
  const currentProposal =
    proposals.length > 0
      ? proposals[Math.min(reviewIndex, proposals.length - 1)]
      : null;
  const reviewedCount = Math.max(0, batchTotal - proposals.length);
  const reviewProgress =
    batchTotal > 0 ? Math.round((reviewedCount / batchTotal) * 100) : 0;

  useEffect(() => {
    if (!proposals.length) {
      setReviewIndex(0);
      setDestEdit("");
      return;
    }
    setReviewIndex((i) => Math.min(i, proposals.length - 1));
  }, [proposals]);

  useEffect(() => {
    if (!currentProposal) {
      setDestEdit("");
      return;
    }
    setDestEdit(currentProposal.suggestedRelpath);
  }, [currentProposal]);

  useEffect(() => {
    if (proposals.length > batchTotal) setBatchTotal(proposals.length);
    if (proposals.length === 0 && step !== 4) setBatchTotal(0);
  }, [proposals.length, batchTotal, step]);

  const stepDone: Record<Step, boolean> = {
    1: foldersReady,
    2: hashedReady,
    3: hasProposals || hasMoves,
    4: hasMoves,
    5: false,
  };

  const nextUnlocked = useMemo(() => {
    if (!foldersReady) return 1 as Step;
    if (!hashedReady) return 2 as Step;
    if (!hasProposals && !hasMoves) return 3 as Step;
    if (hasProposals) return 4 as Step;
    return 5 as Step;
  }, [foldersReady, hashedReady, hasProposals, hasMoves]);

  const setStatusCard = (
    tone: "info" | "success" | "error",
    title: string,
    body: string,
  ) => {
    setNotice({ tone, title, body });
  };

  const run = async (
    label: string,
    fn: () => Promise<void | string | { title: string; detail: string }>,
    goTo?: Step,
  ) => {
    setError(null);
    setBusy(true);
    setStatusCard("info", "Working…", label);
    const toastId = toast.loading(label);
    try {
      const result = await fn();
      await refresh();
      const title =
        typeof result === "object" && result
          ? result.title
          : typeof result === "string" && result
            ? result
            : label.replace(/…$/, "").trim() || "Finished";
      const detail =
        typeof result === "object" && result
          ? result.detail
          : typeof result === "string" && result
            ? result
            : label;
      setStatusCard("success", title, detail);
      toast.success(title, {
        id: toastId,
        description: detail !== title ? detail : undefined,
        duration: 8000,
      });
      if (goTo) setStep(goTo);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(detail);
      setStatusCard("error", "Something went wrong", detail);
      toast.error("Something went wrong", {
        id: toastId,
        description: detail,
        duration: 10000,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
        <div className="flex h-28 shrink-0 flex-col justify-center gap-1 border-b border-border px-5">
          <div className="flex items-center gap-2">
            <SparklesIcon className="size-5" />
            <h1 className="text-lg font-semibold tracking-tight">Untangle</h1>
          </div>
          <p className="text-sm leading-snug text-muted-foreground">
            Follow the steps in order. One clear action on each screen.
          </p>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          {STEPS.map((s) => {
            const done = stepDone[s.id];
            const locked = s.id > nextUnlocked && !done;
            return (
              <Button
                key={s.id}
                type="button"
                variant={step === s.id ? "secondary" : "ghost"}
                disabled={locked || busy}
                className="h-auto justify-start gap-3 px-3 py-2.5"
                onClick={() => setStep(s.id)}
              >
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border text-xs",
                    done
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border",
                  )}
                >
                  {done ? <CheckIcon className="size-3.5" /> : s.id}
                </span>
                <span className="text-left text-sm font-medium">{s.title}</span>
              </Button>
            );
          })}
        </nav>
        <div className="space-y-2 border-t border-border p-4 text-xs text-muted-foreground">
          {ollama && (
            <Badge variant={ollama.ok ? "secondary" : "outline"}>
              {ollama.ok ? "Helper AI ready" : "Helper AI offline"}
            </Badge>
          )}
          {busy && <p>Working…</p>}
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="z-20 flex h-28 shrink-0 flex-col justify-center border-b border-border bg-background/95 px-6 backdrop-blur supports-backdrop-filter:bg-background/80 md:px-8">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Step {step} of 5
          </p>
          <h2 className="mt-0.5 text-2xl font-semibold tracking-tight">
            {STEPS[step - 1].title}
          </h2>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {STEPS[step - 1].blurb}
          </p>
        </header>

        <div
          className={cn(
            "mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4 overscroll-contain p-6 md:p-8",
            step === 4 ? "overflow-hidden" : "overflow-y-auto",
          )}
        >
          {notice && (
            <Card
              className={cn(
                "shrink-0",
                notice.tone === "info" &&
                  "border-[oklch(0.9_0.03_250)] bg-[oklch(0.97_0.01_250)] text-[oklch(0.4_0.08_250)]",
                notice.tone === "success" &&
                  "border-[oklch(0.88_0.06_145)] bg-[oklch(0.96_0.03_145)] text-[oklch(0.38_0.1_145)]",
                notice.tone === "error" &&
                  "border-[oklch(0.9_0.05_27)] bg-[oklch(0.97_0.02_27)] text-destructive",
              )}
            >
              <CardHeader className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <CardTitle className="text-base text-inherit">
                      {notice.title}
                    </CardTitle>
                    <CardDescription className="whitespace-pre-wrap text-sm text-inherit opacity-80">
                      {notice.body}
                    </CardDescription>
                  </div>
                  {error && (
                    <Badge
                      variant="outline"
                      className="shrink-0 border-current/30 bg-background/60 text-inherit"
                    >
                      Error
                    </Badge>
                  )}
                </div>
              </CardHeader>
            </Card>
          )}

          {step === 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Pick two folders</CardTitle>
                <CardDescription>
                  Messy = the pile to clean. Clean = where organized files will
                  live (start empty).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <p className="text-sm font-medium">Messy folder</p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void window.untangle
                          .pickDirectory()
                          .then((p) => p && setMessy(p))
                      }
                    >
                      <FolderOpenIcon data-icon="inline-start" />
                      Choose messy folder…
                    </Button>
                    <p className="min-w-0 flex-1 break-all rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
                      {messy || "Not chosen yet"}
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium">Clean folder</p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void window.untangle
                          .pickDirectory()
                          .then((p) => p && setUntangle(p))
                      }
                    >
                      <FolderOpenIcon data-icon="inline-start" />
                      Choose clean folder…
                    </Button>
                    <p className="min-w-0 flex-1 break-all rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
                      {untangle || "Not chosen yet"}
                    </p>
                  </div>
                </div>
              </CardContent>
              <CardFooter>
                <Button
                  type="button"
                  size="lg"
                  disabled={busy || !messy || !untangle}
                  onClick={() =>
                    void run(
                      "Saving your folders…",
                      async () => {
                        await api({
                          type: "setRoots",
                          roots: {
                            messyPath: messy,
                            untanglePath: untangle,
                          },
                        });
                        await api({ type: "setModel", model: "qwen3:8b" });
                        return {
                          title: "Folders saved",
                          detail: `Messy: ${messy}\nClean: ${untangle}\nHelper model: qwen3:8b`,
                        };
                      },
                      2,
                    )
                  }
                >
                  Save & continue
                </Button>
              </CardFooter>
            </Card>
          )}

          {step === 2 && (
            <Card>
              <CardHeader>
                <CardTitle>Refresh the messy folder</CardTitle>
                <CardDescription>
                  Re-check what’s in Messy now — including files you moved back
                  by hand. This only updates the list; it does not move files.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  type="button"
                  size="lg"
                  disabled={busy || !foldersReady}
                  onClick={() =>
                    void run(
                      "Refreshing messy folder… picking up any files you returned by hand.",
                      async () => {
                        const scan = await api<{
                          seen: number;
                          reclaimed: number;
                        }>({ type: "startScan" });
                        await api({ type: "startHash" });
                        const inv = await api<InventoryCounts>({
                          type: "getInventory",
                        });
                        const typeLines = TYPE_ORDER.filter(
                          (t) => inv.byType[t] > 0,
                        )
                          .map((t) => `${TYPE_LABELS[t]}: ${inv.byType[t]}`)
                          .join(" · ");
                        if (scan.reclaimed > 0) {
                          return {
                            title: `Found ${scan.reclaimed} file(s) you put back`,
                            detail: `Messy now has ${scan.seen} file(s) (${inv.total} tracked). ${typeLines || "No typed files yet."} Ready to suggest again.`,
                          };
                        }
                        return {
                          title: `Listed ${scan.seen} file(s) in Messy`,
                          detail: `${inv.total} tracked after hashing. ${typeLines || "No typed files yet."}`,
                        };
                      },
                      3,
                    )
                  }
                >
                  Refresh messy folder
                </Button>

                {inventory && inventory.total > 0 && (
                  <div className="space-y-3 rounded-xl border border-border p-4">
                    <p className="text-3xl font-semibold tracking-tight">
                      {inventory.total.toLocaleString()} files
                    </p>
                    <ul className="space-y-2">
                      {TYPE_ORDER.filter((t) => inventory.byType[t] > 0).map(
                        (t) => (
                          <li
                            key={t}
                            className="flex items-center justify-between text-sm"
                          >
                            <span>{TYPE_LABELS[t]}</span>
                            <Badge variant="secondary">
                              {inventory.byType[t].toLocaleString()}
                            </Badge>
                          </li>
                        ),
                      )}
                    </ul>
                    <Button type="button" onClick={() => setStep(3)}>
                      Continue to suggestions
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {step === 3 && (
            <Card>
              <CardHeader>
                <CardTitle>Prepare suggestions</CardTitle>
                <CardDescription>
                  Start with spreadsheets, then Word, then PDFs — one group at a
                  time.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    Which files should we suggest places for?
                  </p>
                  <Select
                    value={queueType}
                    onValueChange={(v) => setQueueType(v as QueueType)}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-full max-w-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPE_ORDER.map((t) => (
                        <SelectItem key={t} value={t}>
                          {TYPE_LABELS[t]}
                          {inventory ? ` (${inventory.byType[t]})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="button"
                  size="lg"
                  disabled={busy || !hashedReady}
                  onClick={() =>
                    void run(
                      `Preparing suggestions for ${TYPE_LABELS[queueType]}…`,
                      async () => {
                        const extract = await api<{ extracted: number }>({
                          type: "extractType",
                          queueType,
                        });
                        const batch = await api<{
                          proposed: number;
                          needsModel: number;
                        }>({ type: "proposeBatch", queueType });
                        const next = await api<ProposalView[]>({
                          type: "listProposals",
                        });
                        setBatchTotal(next.length);
                        setReviewIndex(0);
                        return {
                          title:
                            next.length > 0
                              ? `${next.length} suggestion${next.length === 1 ? "" : "s"} ready`
                              : `No suggestions for ${TYPE_LABELS[queueType]}`,
                          detail: [
                            `Type: ${TYPE_LABELS[queueType]}`,
                            `Extracted/read: ${extract.extracted}`,
                            `Newly proposed: ${batch.proposed}`,
                            batch.needsModel > 0
                              ? `Still need helper AI: ${batch.needsModel}`
                              : null,
                            `Waiting in review queue: ${next.length}`,
                          ]
                            .filter(Boolean)
                            .join(" · "),
                        };
                      },
                      4,
                    )
                  }
                >
                  Prepare suggestions
                </Button>
                {hasProposals && (
                  <p className="text-sm text-muted-foreground">
                    {proposals.length} suggestion
                    {proposals.length === 1 ? "" : "s"} ready.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {step === 4 && (
            <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <CardHeader className="shrink-0 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <CardTitle>Review one file at a time</CardTitle>
                    <CardDescription>
                      Check the new home. Change it if needed. Then approve —
                      nothing moves until you say yes.
                    </CardDescription>
                  </div>
                  {batchTotal > 0 && (
                    <Badge variant="secondary">
                      {Math.min(reviewedCount + (currentProposal ? 1 : 0), batchTotal)}{" "}
                      of {batchTotal}
                    </Badge>
                  )}
                </div>
                {batchTotal > 0 && (
                  <div className="space-y-1.5">
                    <Progress value={reviewProgress} />
                    <p className="text-xs text-muted-foreground">
                      {reviewedCount} moved · {proposals.length} still waiting
                    </p>
                  </div>
                )}
              </CardHeader>

              <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
                {!currentProposal ? (
                  <div className="space-y-4 rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
                    <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <CheckIcon className="size-5" />
                    </div>
                    <div className="space-y-1">
                      <p className="font-medium">You’re caught up</p>
                      <p className="text-sm text-muted-foreground">
                        {hasMoves
                          ? "All suggestions in this batch were handled."
                          : "No suggestions waiting yet."}
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button type="button" variant="outline" onClick={() => setStep(3)}>
                        Suggest more files
                      </Button>
                      {hasMoves && (
                        <Button type="button" onClick={() => setStep(5)}>
                          Clean duplicates next
                        </Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <div className="space-y-3 rounded-xl border border-border p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                          This file
                        </p>
                        <Badge variant={confidenceLabel(currentProposal.confidence).tone}>
                          {confidenceLabel(currentProposal.confidence).text}
                        </Badge>
                      </div>
                      <p className="text-base font-semibold tracking-tight">
                        {shortName(currentProposal.sourcePath)}
                      </p>
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">
                          Full path
                        </p>
                        <p className="break-all rounded-lg bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed">
                          {currentProposal.sourcePath}
                        </p>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Why: {reasonFor(currentProposal)}
                      </p>
                    </div>

                    <div className="flex justify-center text-muted-foreground">
                      <ArrowRightIcon className="size-5 rotate-90 sm:rotate-0" />
                    </div>

                    <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
                      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        New home (inside your clean folder)
                      </p>
                      <div className="space-y-2">
                        <Label htmlFor="dest-path">Relative path under clean folder</Label>
                        <textarea
                          id="dest-path"
                          value={destEdit}
                          disabled={busy}
                          rows={3}
                          onChange={(e) => setDestEdit(e.target.value)}
                          placeholder="Finance/Invoices/report.xlsx"
                          className="field-sizing-content min-h-16 w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm break-all leading-relaxed outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50"
                        />
                        <div className="space-y-1">
                          <p className="text-xs font-medium text-muted-foreground">
                            Full destination path
                          </p>
                          <p className="break-all rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs leading-relaxed">
                            {joinDest(
                              roots?.untanglePath ?? untangle,
                              destEdit.trim() || "…",
                            )}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="lg"
                        disabled={busy || !destEdit.trim()}
                        onClick={() =>
                          void run(
                            `Moving ${shortName(currentProposal.sourcePath)}…`,
                            async () => {
                              const sourcePath = currentProposal.sourcePath;
                              const destRel = destEdit.trim();
                              const moved = await api<{
                                beforePath: string;
                                afterPath: string;
                              }>({
                                type: "approveMove",
                                proposalId: currentProposal.id,
                                destRelpath: destRel,
                              });
                              return {
                                title: `Moved ${shortName(moved.afterPath || sourcePath)}`,
                                detail: `From:\n${moved.beforePath || sourcePath}\n\nTo:\n${moved.afterPath || joinDest(roots?.untanglePath ?? untangle, destRel)}`,
                              };
                            },
                          )
                        }
                      >
                        Yes, move it here
                      </Button>
                      <Button
                        type="button"
                        size="lg"
                        variant="outline"
                        disabled={busy || proposals.length < 2}
                        onClick={() =>
                          setReviewIndex((i) => (i + 1) % proposals.length)
                        }
                      >
                        <SkipForwardIcon data-icon="inline-start" />
                        Skip for now
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>

              {(hasMoves || actions.some((a) => !a.undone)) && (
                <CardFooter className="shrink-0 flex flex-wrap gap-2 border-t">
                  {hasMoves && currentProposal && (
                    <Button type="button" variant="ghost" onClick={() => setStep(5)}>
                      Skip to duplicates
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy || !actions.some((a) => !a.undone)}
                    onClick={() =>
                      void run("Putting the last file back…", async () => {
                        const undone = await api<ActionView>({
                          type: "undoLast",
                        });
                        return {
                          title: `Undid ${undone.kind}: ${shortName(undone.afterPath)}`,
                          detail: `Restored to Messy:\n${undone.beforePath}\n\nWas at:\n${undone.afterPath}`,
                        };
                      })
                    }
                  >
                    <Undo2Icon data-icon="inline-start" />
                    Undo last move
                  </Button>
                </CardFooter>
              )}
            </Card>
          )}

          {step === 5 && (
            <Card>
              <CardHeader>
                <CardTitle>Keep one copy</CardTitle>
                <CardDescription>
                  Exact copies and similar versions are grouped. Keep the one
                  you want; others go to Archive.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  type="button"
                  size="lg"
                  disabled={busy}
                  onClick={() =>
                    void run("Looking for duplicates…", async () => {
                      const groups = await api<VersionGroupView[]>({
                        type: "findVersions",
                      });
                      setVersions(groups);
                      const exact = groups.filter((g) => g.kind === "exact")
                        .length;
                      const similar = groups.filter((g) => g.kind !== "exact")
                        .length;
                      const files = groups.reduce(
                        (n, g) => n + g.members.length,
                        0,
                      );
                      if (!groups.length) {
                        return {
                          title: "No duplicate groups found",
                          detail:
                            "Nothing looks like an exact copy or similar version yet. Move more files, then try again.",
                        };
                      }
                      return {
                        title: `Found ${groups.length} duplicate group${groups.length === 1 ? "" : "s"}`,
                        detail: `${files} file(s) across ${exact} identical and ${similar} similar group(s). Pick one keeper in each group; others go to Archive.`,
                      };
                    })
                  }
                >
                  Find duplicates
                </Button>

                {!versions.length && (
                  <p className="text-sm text-muted-foreground">
                    No duplicate groups yet — run this after you’ve moved some
                    files.
                  </p>
                )}

                {versions.map((g) => (
                  <div
                    key={g.id}
                    className="space-y-3 rounded-xl border border-border p-4"
                  >
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium">
                        {g.kind === "exact"
                          ? "Identical copies"
                          : "Similar versions"}
                      </h3>
                      <Badge variant="secondary">{g.members.length} files</Badge>
                    </div>
                    {!!g.mismatches.length && (
                      <details className="text-sm">
                        <summary className="cursor-pointer text-muted-foreground">
                          What’s different?
                        </summary>
                        <pre className="mt-2 overflow-auto rounded-lg bg-muted p-3 text-xs">
                          {g.mismatches.slice(0, 12).join("\n")}
                        </pre>
                      </details>
                    )}
                    <ul className="space-y-3">
                      {g.members.map((m) => (
                        <li
                          key={m.fileId}
                          className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <p className="font-medium">{shortName(m.path)}</p>
                            <p className="break-all font-mono text-xs text-muted-foreground">
                              {m.path}
                            </p>
                          </div>
                          <Button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                `Keeping ${shortName(m.path)} and archiving the others…`,
                                async () => {
                                  const result = await api<{
                                    archived: string[];
                                    winnerPath: string;
                                  }>({
                                    type: "pickWinner",
                                    groupId: g.id,
                                    winnerFileId: m.fileId,
                                  });
                                  setVersions(
                                    await api<VersionGroupView[]>({
                                      type: "findVersions",
                                    }),
                                  );
                                  const archivedList =
                                    result.archived.length > 0
                                      ? result.archived
                                          .map((p) => `• ${p}`)
                                          .join("\n")
                                      : "None (other copies were already gone).";
                                  return {
                                    title: `Kept ${shortName(result.winnerPath)}`,
                                    detail: `Winner:\n${result.winnerPath}\n\nArchived ${result.archived.length} file(s):\n${archivedList}`,
                                  };
                                },
                              )
                            }
                          >
                            Keep this one
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}
