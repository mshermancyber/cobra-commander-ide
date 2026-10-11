import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// DS-T05: Multi-Worker Consensus
//
// Covers:
//  - Multi-model voting mechanism (N workers → majority vote on critical decisions)
//  - Confidence scoring per worker output
//  - Tie-breaker escalation to human
//  - Audit log of consensus decisions
// ---------------------------------------------------------------------------

// ============================================================================
// Types
// ============================================================================

export interface WorkerOutput {
  workerId: string;
  modelName: string;
  result: string;
  confidence: number; // 0.0 - 1.0
  reasoning: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  duration: number; // ms
  tokensUsed: { input: number; output: number };
}

export interface ConsensusVote {
  workerId: string;
  modelName: string;
  choice: 'approve' | 'reject' | 'abstain';
  confidence: number;
  rationale: string;
  timestamp: number;
}

export interface ConsensusDecision {
  id: string;
  question: string;
  proposals: WorkerOutput[];
  votes: ConsensusVote[];
  result: 'approved' | 'rejected' | 'tie' | 'escalated' | 'timeout';
  majorityThreshold: number;
  approvalRate: number;
  winningProposal: WorkerOutput | null;
  escalated: boolean;
  escalationReason?: string;
  humanDecision?: string;
  decidedAt: number;
  duration: number;
}

export interface ConsensusConfig {
  /** Number of workers to query (default 3) */
  workerCount: number;
  /** Majority threshold as fraction (default 0.66 = 2/3) */
  majorityThreshold: number;
  /** Minimum confidence to count a vote (default 0.5) */
  minConfidence: number;
  /** Timeout in ms (default 60000 = 60s) */
  timeout: number;
  /** Whether to escalate ties to human (default true) */
  escalateOnTie: boolean;
  /** Whether to require unanimous decisions */
  requireUnanimity: boolean;
  /** Max retries on timeout (default 0) */
  maxRetries: number;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  event: string;
  decisionId: string;
  workerId?: string;
  modelName?: string;
  details: Record<string, unknown>;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONSENSUS_CONFIG: ConsensusConfig = {
  workerCount: 3,
  majorityThreshold: 0.66,
  minConfidence: 0.5,
  timeout: 60000,
  escalateOnTie: true,
  requireUnanimity: false,
  maxRetries: 0,
};

// ============================================================================
// Mock Worker Runner (in production, calls actual LLM workers)
// ============================================================================

export type WorkerRunner = (question: string, context: string) => Promise<WorkerOutput>;

/**
 * Create a mock worker runner that returns consistent output.
 * In production, this would be replaced with actual LLM calls.
 */
export function createMockWorkerRunner(
  workerId: string,
  modelName: string,
  baseConfidence: number,
): WorkerRunner {
  return async (question: string, _context: string): Promise<WorkerOutput> => {
    // Simulate processing delay
    await new Promise(r => setTimeout(r, Math.random() * 20 + 5));

    return {
      workerId,
      modelName,
      result: `Analysis from ${modelName}: ${question.slice(0, 50)}...`,
      confidence: Math.min(1, Math.max(0, baseConfidence + (Math.random() - 0.5) * 0.2)),
      reasoning: `${modelName} analyzed the question and produced a recommendation.`,
      toolCalls: [],
      duration: Math.floor(Math.random() * 500 + 100),
      tokensUsed: { input: Math.floor(Math.random() * 500 + 100), output: Math.floor(Math.random() * 300 + 50) },
    };
  };
}

// ============================================================================
// Multi-Model Voting Mechanism
// ============================================================================

export class WorkerConsensusEngine {
  private workers: Map<string, WorkerRunner> = new Map();
  private config: ConsensusConfig;
  private auditLog: AuditLogEntry[] = [];
  private decisions: Map<string, ConsensusDecision> = new Map();
  private pendingEscalations: Map<string, ConsensusDecision> = new Map();
  private onEscalate?: (decision: ConsensusDecision) => Promise<string>;

  constructor(config?: Partial<ConsensusConfig>) {
    this.config = { ...DEFAULT_CONSENSUS_CONFIG, ...config };
  }

  /**
   * Register a worker for consensus voting.
   */
  registerWorker(workerId: string, runner: WorkerRunner): void {
    this.workers.set(workerId, runner);
    this.log('worker_registered', '', { workerId });
  }

  /**
   * Unregister a worker.
   */
  unregisterWorker(workerId: string): void {
    this.workers.delete(workerId);
    this.log('worker_unregistered', '', { workerId });
  }

  /**
   * Set the escalation handler (called when tie-breaking is needed).
   */
  setEscalationHandler(handler: (decision: ConsensusDecision) => Promise<string>): void {
    this.onEscalate = handler;
  }

  /**
   * Run consensus on a critical decision.
   *
   * 1. Query N workers in parallel
   * 2. Each worker returns: result + confidence score
   * 3. Workers vote: approve/reject/abstain
   * 4. Majority threshold determines outcome
   * 5. If tie → escalate to human
   */
  async decide(question: string, context: string, criticality: 'low' | 'medium' | 'high' | 'critical' = 'medium'): Promise<ConsensusDecision> {
    const decisionId = `dec-${randomUUID().slice(0, 8)}`;
    const startTime = Date.now();

    this.log('consensus_started', decisionId, { question: question.slice(0, 100), criticality });

    // Adjust threshold based on criticality
    const adjustedThreshold = criticality === 'critical'
      ? Math.max(this.config.majorityThreshold, 0.75)
      : criticality === 'high'
        ? this.config.majorityThreshold
        : Math.max(0.5, this.config.majorityThreshold - 0.16);

    // Gather worker outputs
    const workerEntries = [...this.workers.entries()];
    if (workerEntries.length === 0) {
      const decision = this.createDecision(decisionId, question, [], [], adjustedThreshold, startTime);
      decision.result = 'escalated';
      decision.escalated = true;
      decision.escalationReason = 'No workers registered';
      this.decisions.set(decisionId, decision);
      return decision;
    }

    // Take up to workerCount workers
    const selectedWorkers = workerEntries.slice(0, this.config.workerCount);

    // Query workers in parallel with timeout
    const timeout = this.config.timeout;
    const proposals = await Promise.all(
      selectedWorkers.map(async ([id, runner]) => {
        try {
          const result = await Promise.race([
            runner(question, context),
            new Promise<WorkerOutput>((_, reject) =>
              setTimeout(() => reject(new Error(`Worker ${id} timed out`)), timeout)
            ),
          ]);
          return result;
        } catch {
          return null;
        }
      })
    );

    const validProposals = proposals.filter((p): p is WorkerOutput => p !== null);
    this.log('proposals_gathered', decisionId, {
      total: selectedWorkers.length,
      received: validProposals.length,
      timedOut: selectedWorkers.length - validProposals.length,
    });

    if (validProposals.length === 0) {
      const decision = this.createDecision(decisionId, question, [], [], adjustedThreshold, startTime);
      decision.result = 'timeout';
      decision.escalationReason = 'All workers timed out';
      decision.escalated = true;
      this.decisions.set(decisionId, decision);
      return decision;
    }

    // Workers vote based on their confidence
    const votes: ConsensusVote[] = validProposals.map(p => {
      const vote = this.determineVote(p);
      return vote;
    });

    this.log('votes_cast', decisionId, {
      approve: votes.filter(v => v.choice === 'approve').length,
      reject: votes.filter(v => v.choice === 'reject').length,
      abstain: votes.filter(v => v.choice === 'abstain').length,
    });

    // Tally votes with confidence weighting
    const result = this.tallyVotes(decisionId, question, validProposals, votes, adjustedThreshold, startTime);

    // Handle ties and non-consensus
    if (result.result === 'tie' && this.config.escalateOnTie) {
      return this.escalateToHuman(result);
    }

    // Handle unanimous requirement
    if (this.config.requireUnanimity && result.approvalRate < 1.0) {
      result.result = 'rejected';
      result.escalationReason = `Unanimity required but only ${(result.approvalRate * 100).toFixed(0)}% approved`;
    }

    this.decisions.set(decisionId, result);
    this.log('consensus_completed', decisionId, {
      result: result.result,
      approvalRate: result.approvalRate,
      duration: result.duration,
    });

    return result;
  }

  /**
   * Determine how a worker votes based on its output and confidence.
   */
  private determineVote(output: WorkerOutput): ConsensusVote {
    let choice: ConsensusVote['choice'];
    let rationale: string;

    if (output.confidence >= 0.8) {
      choice = 'approve';
      rationale = `High confidence (${(output.confidence * 100).toFixed(0)}%) in ${output.modelName} output.`;
    } else if (output.confidence >= this.config.minConfidence) {
      choice = 'approve';
      rationale = `Acceptable confidence (${(output.confidence * 100).toFixed(0)}%) from ${output.modelName}.`;
    } else if (output.confidence >= 0.3) {
      choice = 'abstain';
      rationale = `Low confidence (${(output.confidence * 100).toFixed(0)}%) — ${output.modelName} is uncertain.`;
    } else {
      choice = 'reject';
      rationale = `Very low confidence (${(output.confidence * 100).toFixed(0)}%) — ${output.modelName} recommends rejection.`;
    }

    return {
      workerId: output.workerId,
      modelName: output.modelName,
      choice,
      confidence: output.confidence,
      rationale,
      timestamp: Date.now(),
    };
  }

  /**
   * Tally votes and compute the consensus result with confidence scoring.
   */
  private tallyVotes(
    decisionId: string,
    question: string,
    proposals: WorkerOutput[],
    votes: ConsensusVote[],
    threshold: number,
    startTime: number,
  ): ConsensusDecision {
    const approveVotes = votes.filter(v => v.choice === 'approve');
    const rejectVotes = votes.filter(v => v.choice === 'reject');
    const abstainVotes = votes.filter(v => v.choice === 'abstain');
    const decidingVotes = votes.filter(v => v.choice !== 'abstain');

    const totalDeciding = decidingVotes.length;
    const approvalRate = totalDeciding > 0
      ? approveVotes.length / totalDeciding
      : 0;

    // Compute weighted confidence (higher weight for higher confidence votes)
    const weightedApproveScore = approveVotes.reduce((sum, v) => sum + v.confidence, 0);
    const totalConfidence = decidingVotes.reduce((sum, v) => sum + v.confidence, 0);
    const confidenceWeightedRate = totalConfidence > 0 ? weightedApproveScore / totalConfidence : 0;

    let result: ConsensusDecision['result'];

    if (totalDeciding === 0) {
      result = 'tie';
    } else if (approvalRate >= threshold) {
      result = 'approved';
    } else if (approvalRate <= (1 - threshold)) {
      result = 'rejected';
    } else {
      result = 'tie';
    }

    // Find winning proposal (highest confidence among approvers)
    const winningProposal = result === 'approved'
      ? approveVotes
          .map(v => proposals.find(p => p.workerId === v.workerId)!)
          .filter(Boolean)
          .sort((a, b) => b.confidence - a.confidence)[0] || null
      : null;

    return {
      id: decisionId,
      question,
      proposals,
      votes,
      result,
      majorityThreshold: threshold,
      approvalRate: confidenceWeightedRate,
      winningProposal,
      escalated: false,
      decidedAt: Date.now(),
      duration: Date.now() - startTime,
    };
  }

  /**
   * Escalate a tied or contentious decision to a human for resolution.
   */
  private async escalateToHuman(decision: ConsensusDecision): Promise<ConsensusDecision> {
    decision.result = 'escalated';
    decision.escalated = true;
    decision.escalationReason = `Tie detected — ${decision.approvalRate.toFixed(2)} approval rate below threshold ${decision.majorityThreshold}`;

    this.pendingEscalations.set(decision.id, decision);
    this.log('escalated_to_human', decision.id, {
      question: decision.question.slice(0, 100),
      proposals: decision.proposals.map(p => ({ workerId: p.workerId, confidence: p.confidence })),
      votes: decision.votes.map(v => ({ choice: v.choice, confidence: v.confidence })),
    });

    if (this.onEscalate) {
      try {
        const humanDecision = await this.onEscalate(decision);
        decision.humanDecision = humanDecision;
        decision.result = 'approved';
        decision.escalated = false;
        this.log('human_decision_received', decision.id, { decision: humanDecision });
      } catch (err) {
        decision.humanDecision = `Human escalation failed: ${(err as Error).message}`;
        this.log('human_decision_failed', decision.id, { error: (err as Error).message });
      }
    }

    this.pendingEscalations.delete(decision.id);
    this.decisions.set(decision.id, decision);
    return decision;
  }

  /**
   * Get a pending escalation by decision ID.
   */
  getPendingEscalation(decisionId: string): ConsensusDecision | undefined {
    return this.pendingEscalations.get(decisionId);
  }

  /**
   * List all pending escalations.
   */
  listPendingEscalations(): ConsensusDecision[] {
    return [...this.pendingEscalations.values()];
  }

  /**
   * Provide a human decision for a pending escalation.
   */
  resolveEscalation(decisionId: string, humanDecision: string): ConsensusDecision | null {
    const decision = this.pendingEscalations.get(decisionId);
    if (!decision) return null;

    decision.humanDecision = humanDecision;
    decision.result = 'approved';
    decision.escalated = false;
    decision.decidedAt = Date.now();

    this.pendingEscalations.delete(decisionId);
    this.decisions.set(decisionId, decision);

    this.log('escalation_resolved', decisionId, { humanDecision });
    return decision;
  }

  /**
   * Retry a failed decision with adjusted parameters.
   */
  async retry(decisionId: string, context: string): Promise<ConsensusDecision | null> {
    const previous = this.decisions.get(decisionId);
    if (!previous) return null;

    return this.decide(previous.question, context, 'high');
  }

  // ── Query Methods ──────────────────────────────────────────────────

  getDecision(decisionId: string): ConsensusDecision | undefined {
    return this.decisions.get(decisionId);
  }

  listDecisions(filter?: (d: ConsensusDecision) => boolean): ConsensusDecision[] {
    const all = [...this.decisions.values()];
    return filter ? all.filter(filter) : all;
  }

  getDecisionsByResult(result: ConsensusDecision['result']): ConsensusDecision[] {
    return this.listDecisions(d => d.result === result);
  }

  getWorkerCount(): number {
    return this.workers.size;
  }

  // ── Confidence Scoring Per Worker ───────────────────────────────────

  /**
   * Compute aggregate confidence across all proposals in a decision.
   */
  computeAggregateConfidence(decision: ConsensusDecision): {
    mean: number;
    median: number;
    min: number;
    max: number;
    stdDev: number;
  } {
    const confidences = decision.proposals.map(p => p.confidence);
    if (confidences.length === 0) {
      return { mean: 0, median: 0, min: 0, max: 0, stdDev: 0 };
    }

    const sorted = [...confidences].sort((a, b) => a - b);
    const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const median = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
    const variance = confidences.reduce((s, c) => s + (c - mean) ** 2, 0) / confidences.length;

    return {
      mean: Math.round(mean * 1000) / 1000,
      median: Math.round(median * 1000) / 1000,
      min: Math.round(sorted[0] * 1000) / 1000,
      max: Math.round(sorted[sorted.length - 1] * 1000) / 1000,
      stdDev: Math.round(Math.sqrt(variance) * 1000) / 1000,
    };
  }

  /**
   * Check if confidence spread indicates disagreement.
   * High stdDev means workers disagree significantly.
   */
  hasSignificantDisagreement(decision: ConsensusDecision, thresholdStdDev = 0.2): boolean {
    const stats = this.computeAggregateConfidence(decision);
    return stats.stdDev > thresholdStdDev;
  }

  // ── Audit Log ──────────────────────────────────────────────────────

  private log(
    event: string,
    decisionId: string,
    details: Record<string, unknown>,
  ): void {
    const entry: AuditLogEntry = {
      id: `log-${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      event,
      decisionId,
      details,
    };

    if (details.workerId) {
      entry.workerId = details.workerId as string;
    }
    if (details.modelName) {
      entry.modelName = details.modelName as string;
    }

    this.auditLog.push(entry);
  }

  /**
   * Get the full audit log.
   */
  getAuditLog(): AuditLogEntry[] {
    return [...this.auditLog];
  }

  /**
   * Get audit log entries for a specific decision.
   */
  getAuditLogForDecision(decisionId: string): AuditLogEntry[] {
    return this.auditLog.filter(e => e.decisionId === decisionId);
  }

  /**
   * Export audit log to a JSON file.
   */
  exportAuditLog(outputPath: string): void {
    const dir = outputPath.split('/').slice(0, -1).join('/') || '.';
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const stream = createWriteStream(outputPath, 'utf-8');
    stream.write(JSON.stringify(this.auditLog, null, 2));
    stream.end();
  }

  /**
   * Query audit log by event type.
   */
  queryAuditLog(eventType: string): AuditLogEntry[] {
    return this.auditLog.filter(e => e.event === eventType);
  }

  /**
   * Clear the audit log (use with caution).
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  /**
   * Generate a human-readable audit report.
   */
  generateAuditReport(): string {
    const lines: string[] = [
      '# Consensus Audit Report',
      `Generated: ${new Date().toISOString()}`,
      `Total events: ${this.auditLog.length}`,
      `Total decisions: ${this.decisions.size}`,
      `Pending escalations: ${this.pendingEscalations.size}`,
      '',
      '## Event Summary',
    ];

    const eventCounts = new Map<string, number>();
    for (const entry of this.auditLog) {
      eventCounts.set(entry.event, (eventCounts.get(entry.event) || 0) + 1);
    }

    for (const [event, count] of eventCounts) {
      lines.push(`- ${event}: ${count}`);
    }

    lines.push('');
    lines.push('## Decision Outcomes');

    const outcomeCounts = new Map<string, number>();
    for (const [, decision] of this.decisions) {
      outcomeCounts.set(decision.result, (outcomeCounts.get(decision.result) || 0) + 1);
    }

    for (const [outcome, count] of outcomeCounts) {
      lines.push(`- ${outcome}: ${count}`);
    }

    lines.push('');
    lines.push('## Recent Escalations');

    const escalations = this.listDecisions(d => d.escalated);
    for (const esc of escalations.slice(-5)) {
      lines.push(`- **${esc.id}**: ${esc.question.slice(0, 80)}... → ${esc.humanDecision || 'pending'}`);
    }

    return lines.join('\n');
  }

  // ── Private Helpers ────────────────────────────────────────────────

  private createDecision(
    id: string,
    question: string,
    proposals: WorkerOutput[],
    votes: ConsensusVote[],
    threshold: number,
    startTime: number,
  ): ConsensusDecision {
    return {
      id,
      question,
      proposals,
      votes,
      result: 'tie' as const,
      majorityThreshold: threshold,
      approvalRate: 0,
      winningProposal: null,
      escalated: false,
      decidedAt: 0,
      duration: Date.now() - startTime,
    };
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Create a pre-configured consensus engine with mock workers.
 */
export function createConsensusEngine(
  workerCount = 3,
  config?: Partial<ConsensusConfig>,
): WorkerConsensusEngine {
  const engine = new WorkerConsensusEngine(config);

  const modelNames = ['claude-3.5-sonnet', 'gpt-4o', 'gpt-5.1-mini'];
  const baseConfidences = [0.85, 0.80, 0.75];

  for (let i = 0; i < workerCount; i++) {
    const workerId = `worker-${i + 1}`;
    const modelName = modelNames[i % modelNames.length];
    const confidence = baseConfidences[i % baseConfidences.length];
    const runner = createMockWorkerRunner(workerId, modelName, confidence);
    engine.registerWorker(workerId, runner);
  }

  return engine;
}
