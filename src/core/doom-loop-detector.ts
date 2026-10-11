/**
 * Doom Loop Detector — Detects when a worker keeps calling the same tool
 * with identical arguments, indicating it's stuck in a futile cycle.
 *
 * Usage:
 *   const detector = new DoomLoopDetector(3);
 *   const { isDoom, count } = detector.record(toolName, toolInput);
 *   if (isDoom) { /* warn or break *\/ }
 */

export interface DoomLoopResult {
  isDoom: boolean;
  count: number;
}

/** Tool names that legitimately repeat — never flagged as doom loops. */
const IGNORED_TOOLS = new Set<string>();

/**
 * run_command repeats more legitimately than edits (status checks, re-runs),
 * so it needs a higher bar — but an identical FAILING command looped forever
 * is the most common doom loop and must still be caught.
 */
const RUN_COMMAND_THRESHOLD = 5;

/** How many recent calls to examine. */
const WINDOW_SIZE = 8;

export class DoomLoopDetector {
  private history: Array<{ toolName: string; inputKey: string }> = [];
  private threshold: number;
  private warningCount = 0;

  constructor(threshold: number = 3) {
    this.threshold = threshold;
  }

  /**
   * Record a tool call and check for doom-loop patterns.
   *
   * @param toolName  The name of the tool being called.
   * @param toolInput The tool's input arguments (will be JSON-stringified for comparison).
   * @returns { isDoom, count } — isDoom is true when the same (tool, input)
   *          pair appears at least `threshold` times in the last WINDOW_SIZE calls.
   */
  record(toolName: string, toolInput: unknown): DoomLoopResult {
    // Skip tools that legitimately repeat
    if (IGNORED_TOOLS.has(toolName)) {
      return { isDoom: false, count: 0 };
    }

    const inputKey = JSON.stringify(toolInput);
    this.history.push({ toolName, inputKey });

    // Keep window capped
    while (this.history.length > WINDOW_SIZE) {
      this.history.shift();
    }

    // Count occurrences of this exact (tool, input) combo in the window
    let count = 0;
    for (const entry of this.history) {
      if (entry.toolName === toolName && entry.inputKey === inputKey) {
        count++;
      }
    }

    const threshold = toolName === 'run_command'
      ? Math.max(this.threshold, RUN_COMMAND_THRESHOLD)
      : this.threshold;
    const isDoom = count >= threshold;

    if (isDoom) {
      this.warningCount++;
    }

    return { isDoom, count };
  }

  /** Reset all tracking state (history + warning counter). */
  reset(): void {
    this.history = [];
    this.warningCount = 0;
  }

  /** How many doom-loop warnings have been issued since last reset. */
  get warnings(): number {
    return this.warningCount;
  }
}
