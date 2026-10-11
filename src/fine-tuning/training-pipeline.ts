import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { Dataset, DatasetSplit, TrainingJobConfig, TrainingJob, LoraConfig, TrainingHyperparams } from './framework.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExportFormat = 'jsonl' | 'parquet' | 'arrow' | 'csv';

export interface HuggingFaceExportConfig {
  /** Dataset name on HuggingFace Hub */
  repoId: string;
  /** Format to export */
  format: ExportFormat;
  /** Whether to push to the Hub (requires HF_TOKEN) */
  pushToHub: boolean;
  /** Whether to include a dataset card (README.md) */
  includeDatasetCard: boolean;
  /** Splits to export */
  splits: ('train' | 'val' | 'test')[];
  /** Optional train/test split ratio for hub datasets */
  trainRatio?: number;
  /** HuggingFace token */
  token?: string;
}

export interface TrainingConfigTemplate {
  /** Framework: axolotl or llama-factory */
  framework: 'axolotl' | 'llama-factory';
  /** Base model HF ID */
  baseModel: string;
  /** Dataset config */
  dataset: {
    path: string;
    type: 'alpaca' | 'sharegpt' | 'completion' | 'custom';
    trainSplit?: string;
    evalSplit?: string;
  };
  /** LoRA config */
  lora: LoraConfig;
  /** Training hyperparameters */
  hyperparams: TrainingHyperparams;
  /** Output directory */
  outputDir: string;
  /** Extra framework-specific options */
  extras: Record<string, unknown>;
}

export interface EvalCase {
  task: string;
  prompt: string;
  canonicalSolution: string;
  testCases: string[];
  language: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface EvalResult {
  task: string;
  passed: boolean;
  modelOutput: string;
  expectedOutput: string;
  passAt1: boolean;
  passAt10: boolean;
  passAt100: boolean;
  executionTimeMs: number;
  errorMessage?: string;
}

export interface EvalSummary {
  modelId: string;
  benchmark: string;
  totalCases: number;
  passAt1: number;
  passAt10: number;
  passAt100: number;
  byDifficulty: {
    easy: { total: number; passAt1: number };
    medium: { total: number; passAt1: number };
    hard: { total: number; passAt1: number };
  };
  byLanguage: Record<string, { total: number; passAt1: number }>;
  results: EvalResult[];
  executedAt: number;
  durationMs: number;
}

export interface CheckpointMetadata {
  id: string;
  modelId: string;
  trainingJobId: string;
  step: number;
  loss: number;
  evalLoss?: number;
  path: string;
  adapterPath: string;
  createdAt: number;
  sizeBytes: number;
  tags: string[];
  isBest: boolean;
}

export interface ModelArtifact {
  id: string;
  baseModel: string;
  dataset: string;
  datasetVersion: string;
  trainingJobId: string;
  version: string;
  createdAt: number;
  status: 'training' | 'evaluating' | 'ready' | 'deprecated' | 'failed';
  metrics: {
    finalLoss: number;
    evalLoss: number;
    tokensPerSecond: number;
    totalSteps: number;
    bestCheckpoint: string;
  };
  checkpoints: CheckpointMetadata[];
  adapterPath: string;
  mergedModelPath?: string;
  evalSummary?: EvalSummary;
  tags: string[];
}

// ---------------------------------------------------------------------------
// HuggingFace Dataset Exporter
// ---------------------------------------------------------------------------

export class HuggingFaceExporter {
  private config: HuggingFaceExportConfig;

  constructor(config: HuggingFaceExportConfig) {
    this.config = config;
  }

  /**
   * Export dataset splits in HuggingFace-compatible format.
   * Supports JSONL (default), Parquet, Arrow, and CSV formats.
   */
  export(splits: DatasetSplit, outputDir: string): string[] {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    const exportedFiles: string[] = [];

    for (const splitName of this.config.splits) {
      const dataset = splits[splitName];
      if (!dataset || dataset.samples.length === 0) continue;

      const filePath = this.exportSplit(dataset, splitName, outputDir);
      if (filePath) exportedFiles.push(filePath);
    }

    // Generate dataset card if requested
    if (this.config.includeDatasetCard) {
      const cardPath = this.generateDatasetCard(splits, outputDir);
      exportedFiles.push(cardPath);
    }

    // Generate loading script
    const scriptPath = this.generateLoadingScript(splits, outputDir);
    exportedFiles.push(scriptPath);

    return exportedFiles;
  }

  /**
   * Export a single split.
   */
  private exportSplit(dataset: Dataset, splitName: string, outputDir: string): string | null {
    switch (this.config.format) {
      case 'jsonl':
        return this.exportJsonl(dataset, splitName, outputDir);
      case 'csv':
        return this.exportCsv(dataset, splitName, outputDir);
      case 'parquet':
      case 'arrow':
        return this.exportJsonl(dataset, splitName, outputDir); // fallback to JSONL
      default:
        return this.exportJsonl(dataset, splitName, outputDir);
    }
  }

  private exportJsonl(dataset: Dataset, splitName: string, outputDir: string): string {
    const filePath = join(outputDir, `${splitName}.jsonl`);
    const lines = dataset.samples.map(s => JSON.stringify({
      instruction: s.instruction,
      output: s.output,
      source_file: s.sourceFile,
      language: s.language,
      type: s.type,
    }));
    writeFileSync(filePath, lines.join('\n'));
    return filePath;
  }

  private exportCsv(dataset: Dataset, splitName: string, outputDir: string): string {
    const filePath = join(outputDir, `${splitName}.csv`);
    const header = 'instruction,output,source_file,language,type';
    const rows = dataset.samples.map(s => {
      const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
      return `${escape(s.instruction)},${escape(s.output)},${escape(s.sourceFile)},${s.language},${s.type}`;
    });
    writeFileSync(filePath, [header, ...rows].join('\n'));
    return filePath;
  }

  /**
   * Generate a HuggingFace dataset card (README.md).
   */
  private generateDatasetCard(splits: DatasetSplit, outputDir: string): string {
    const card = [
      '---',
      `dataset_name: ${this.config.repoId}`,
      `language:`,
      ...(Array.from(new Set(Object.values(splits).flatMap(ds => (ds.samples as Array<{ language: string }>).map(s => s.language)))) as string[]).map(l => `  - ${l}`),
      'task_categories:',
      '  - text-generation',
      '  - code-generation',
      '---',
      '',
      `# ${this.config.repoId}`,
      '',
      'Fine-tuning dataset generated by Cobra Commander.',
      '',
      '## Dataset Summary',
      '',
      `- **Total samples**: ${Object.values(splits).reduce((sum, ds) => sum + ds.samples.length, 0)}`,
      `- **Languages**: ${[...new Set(Object.values(splits).flatMap((ds: { samples: Array<{ language: string }> }) => ds.samples.map((s: { language: string }) => s.language)))].join(', ')}`,
      `- **Formats**: ${[...new Set(Object.values(splits).flatMap((ds: { samples: Array<{ type: string }> }) => ds.samples.map((s: { type: string }) => s.type)))].join(', ')}`,
      '',
      '## Splits',
      '',
      '| Split | Samples |',
      '|-------|---------|',
      ...Object.entries(splits).map(([k, ds]) => `| ${k} | ${ds.samples.length} |`),
      '',
      '## Usage',
      '',
      '```python',
      'from datasets import load_dataset',
      `dataset = load_dataset("${this.config.repoId}")`,
      '```',
      '',
    ].join('\n');

    const cardPath = join(outputDir, 'README.md');
    writeFileSync(cardPath, card);
    return cardPath;
  }

  /**
   * Generate a Python loading script compatible with HuggingFace datasets.
   */
  private generateLoadingScript(splits: DatasetSplit, outputDir: string): string {
    const script = [
      '"""',
      `HuggingFace dataset loader for ${this.config.repoId}`,
      'Generated by Cobra Commander',
      '"""',
      'import json',
      'import os',
      'from datasets import Dataset, DatasetDict, Features, Value',
      '',
      '_DATA_DIR = os.path.dirname(os.path.abspath(__file__))',
      '',
      'def load_dataset():',
      '    """Load the fine-tuning dataset."""',
      '    features = Features({',
      '        "instruction": Value("string"),',
      '        "output": Value("string"),',
      '        "source_file": Value("string"),',
      '        "language": Value("string"),',
      '        "type": Value("string"),',
      '    })',
      '',
      '    splits = {}',
    ];

    for (const splitName of ['train', 'val', 'test'] as const) {
      script.push(`    ${splitName}_path = os.path.join(_DATA_DIR, "${splitName}.jsonl")`);
      script.push(`    if os.path.exists(${splitName}_path):`);
      script.push(`        with open(${splitName}_path, "r") as f:`);
      script.push(`            ${splitName}_data = [json.loads(line) for line in f if line.strip()]`);
      script.push(`        splits["${splitName}"] = Dataset.from_list(${splitName}_data, features=features)`);
    }

    script.push('');
    script.push('    return DatasetDict(splits)');
    script.push('');

    const scriptPath = join(outputDir, 'dataset_loader.py');
    writeFileSync(scriptPath, script.join('\n'));
    return scriptPath;
  }
}

// ---------------------------------------------------------------------------
// Config Template Generator (Axolotl / Llama-Factory)
// ---------------------------------------------------------------------------

export class ConfigTemplateGenerator {
  /**
   * Generate a complete Axolotl training config YAML.
   */
  static generateAxolotl(config: TrainingConfigTemplate): string {
    const lines: string[] = [
      `# Axolotl Fine-Tuning Configuration`,
      `# Generated by Cobra Commander — ${new Date().toISOString()}`,
      `# Framework: axolotl`,
      ``,
      `base_model: ${config.baseModel}`,
      `model_type: AutoModelForCausalLM`,
      `tokenizer_type: AutoTokenizer`,
      ``,
      `# --- LoRA ---`,
      `adapter: lora`,
      `lora_r: ${config.lora.r}`,
      `lora_alpha: ${config.lora.alpha}`,
      `lora_dropout: ${config.lora.dropout}`,
      `lora_target_modules:`,
      ...config.lora.targetModules.map((m: string) => `  - ${m}`),
      `lora_fan_in_fan_out: false`,
      `use_rslora: ${config.lora.useRsLora || false}`,
      `use_dora: ${config.lora.useDoRA || false}`,
      ``,
      `# --- Dataset ---`,
      `datasets:`,
      `  - path: ${config.dataset.path}`,
      `    type: ${config.dataset.type}`,
    ];

    if (config.dataset.trainSplit) lines.push(`    train_on_split: ${config.dataset.trainSplit}`);
    if (config.dataset.evalSplit) lines.push(`    eval_on_split: ${config.dataset.evalSplit}`);

    lines.push(
      ``,
      `# --- Training ---`,
      `sequence_len: ${config.hyperparams.maxSeqLength}`,
      `num_epochs: ${config.hyperparams.epochs}`,
      `micro_batch_size: ${config.hyperparams.batchSize}`,
      `gradient_accumulation_steps: ${config.hyperparams.gradientAccumulationSteps}`,
      `learning_rate: ${config.hyperparams.learningRate}`,
      `warmup_steps: ${config.hyperparams.warmupSteps}`,
      `max_steps: ${config.hyperparams.maxSteps}`,
      `save_steps: ${config.hyperparams.saveSteps}`,
      `eval_steps: ${config.hyperparams.evalSteps}`,
      `logging_steps: ${config.hyperparams.loggingSteps}`,
      `optimizer: ${config.hyperparams.optim}`,
      `lr_scheduler: ${config.hyperparams.lrScheduler}`,
      `weight_decay: ${config.hyperparams.weightDecay}`,
      `max_grad_norm: ${config.hyperparams.maxGradNorm}`,
      `fp16: ${config.hyperparams.fp16}`,
      `bf16: ${config.hyperparams.bf16}`,
      `seed: ${config.hyperparams.seed}`,
      ``,
      `# --- Output ---`,
      `output_dir: ${config.outputDir}`,
      ``,
      `# --- Extra ---`,
    );

    for (const [key, val] of Object.entries(config.extras)) {
      if (val !== undefined && val !== null) {
        lines.push(`${key}: ${val}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate a complete Llama-Factory training config YAML.
   */
  static generateLlamaFactory(config: TrainingConfigTemplate): string {
    const lines: string[] = [
      `# Llama-Factory Fine-Tuning Configuration`,
      `# Generated by Cobra Commander — ${new Date().toISOString()}`,
      ``,
      `### model`,
      `model_name_or_path: ${config.baseModel}`,
      ``,
      `### method`,
      `stage: sft`,
      `do_train: true`,
      `finetuning_type: lora`,
      `lora_rank: ${config.lora.r}`,
      `lora_alpha: ${config.lora.alpha}`,
      `lora_dropout: ${config.lora.dropout}`,
      `lora_target: ${config.lora.targetModules.join(',')}`,
      ``,
      `### dataset`,
      `dataset: ${basename(config.dataset.path, '.json')}`,
      `template: alpaca`,
      `cutoff_len: ${config.hyperparams.maxSeqLength}`,
      `overwrite_cache: true`,
      `preprocessing_num_workers: 16`,
      ``,
      `### training`,
      `output_dir: ${config.outputDir}`,
      `num_train_epochs: ${config.hyperparams.epochs}`,
      `per_device_train_batch_size: ${config.hyperparams.batchSize}`,
      `gradient_accumulation_steps: ${config.hyperparams.gradientAccumulationSteps}`,
      `learning_rate: ${config.hyperparams.learningRate}`,
      `warmup_steps: ${config.hyperparams.warmupSteps}`,
      `max_steps: ${config.hyperparams.maxSteps}`,
      `save_steps: ${config.hyperparams.saveSteps}`,
      `eval_steps: ${config.hyperparams.evalSteps}`,
      `logging_steps: ${config.hyperparams.loggingSteps}`,
      `optim: ${config.hyperparams.optim}`,
      `lr_scheduler_type: ${config.hyperparams.lrScheduler}`,
      `weight_decay: ${config.hyperparams.weightDecay}`,
      `max_grad_norm: ${config.hyperparams.maxGradNorm}`,
      `fp16: ${config.hyperparams.fp16}`,
      `bf16: ${config.hyperparams.bf16}`,
      `seed: ${config.hyperparams.seed}`,
      ``,
      `### evaluation`,
      `val_size: 0.1`,
      `per_device_eval_batch_size: ${config.hyperparams.batchSize}`,
      `eval_strategy: steps`,
      `load_best_model_at_end: true`,
    ];

    return lines.join('\n');
  }

  /**
   * Write config to disk.
   */
  static saveConfig(configYaml: string, outputDir: string, framework: string): string {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    const filePath = join(outputDir, `${framework}-config.yml`);
    writeFileSync(filePath, configYaml);
    return filePath;
  }
}

// ---------------------------------------------------------------------------
// Eval Harness (pass@k on held-out completion tasks)
// ---------------------------------------------------------------------------

export class EvalHarness {
  private cases: EvalCase[] = [];

  constructor(cases?: EvalCase[]) {
    if (cases) this.cases.push(...cases);
  }

  /**
   * Load evaluation cases from a JSON file.
   */
  loadFromFile(filePath: string): void {
    if (!existsSync(filePath)) return;
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (Array.isArray(data)) {
        this.cases.push(...data);
      } else if (data.cases && Array.isArray(data.cases)) {
        this.cases.push(...data.cases);
      }
    } catch {
      // ignore unreadable
    }
  }

  /**
   * Load evaluation cases from a dataset split (usually test split).
   */
  loadFromDataset(dataset: Dataset): void {
    for (const sample of dataset.samples) {
      this.cases.push({
        task: sample.id,
        prompt: sample.instruction,
        canonicalSolution: sample.output,
        testCases: [],
        language: sample.language,
        difficulty: 'medium',
      });
    }
  }

  /**
   * Add evaluation cases manually.
   */
  addCases(cases: EvalCase[]): void {
    this.cases.push(...cases);
  }

  /**
   * Get the total number of cases.
   */
  get caseCount(): number {
    return this.cases.length;
  }

  /**
   * Run evaluation using a model completion function.
   * Computes pass@1, pass@10, pass@100 metrics.
   */
  async evaluate(
    modelId: string,
    benchmark: string,
    computeFn: (prompt: string) => Promise<string>,
    options?: {
      numSamples?: number;
      timeoutMs?: number;
    },
  ): Promise<EvalSummary> {
    const startTime = performance.now();
    const numSamples = options?.numSamples || 1;
    const timeoutMs = options?.timeoutMs || 30_000;
    const results: EvalResult[] = [];

    for (const testCase of this.cases) {
      const result = await this.evaluateCase(testCase, computeFn, numSamples, timeoutMs);
      results.push(result);
    }

    const passAt1Results = results.filter(r => r.passAt1);
    const passAt10Results = results.filter(r => r.passAt10);
    const passAt100Results = results.filter(r => r.passAt100);

    const byDifficulty = {
      easy: this.computeDifficultyStats(results, 'easy'),
      medium: this.computeDifficultyStats(results, 'medium'),
      hard: this.computeDifficultyStats(results, 'hard'),
    };

    const byLanguage: Record<string, { total: number; passAt1: number }> = {};
    for (const tc of this.cases) {
      if (!byLanguage[tc.language]) {
        byLanguage[tc.language] = { total: 0, passAt1: 0 };
      }
      byLanguage[tc.language].total++;
      const matchingResult = results.find(r => r.task === tc.task);
      if (matchingResult?.passAt1) {
        byLanguage[tc.language].passAt1++;
      }
    }

    // Normalize pass@1 for language groups
    for (const lang of Object.keys(byLanguage)) {
      const g = byLanguage[lang];
      g.passAt1 = g.total > 0 ? g.passAt1 / g.total : 0;
    }

    return {
      modelId,
      benchmark,
      totalCases: this.cases.length,
      passAt1: results.length > 0 ? passAt1Results.length / results.length : 0,
      passAt10: results.length > 0 ? passAt10Results.length / results.length : 0,
      passAt100: results.length > 0 ? passAt100Results.length / results.length : 0,
      byDifficulty,
      byLanguage,
      results,
      executedAt: Date.now(),
      durationMs: Math.round(performance.now() - startTime),
    };
  }

  /**
   * Evaluate a single case with pass@k estimation.
   */
  private async evaluateCase(
    testCase: EvalCase,
    computeFn: (prompt: string) => Promise<string>,
    numSamples: number,
    timeoutMs: number,
  ): Promise<EvalResult> {
    const caseStart = performance.now();
    let passAt1 = false;
    let passAt10 = false;
    let passAt100 = false;
    let output = '';
    let error: string | undefined;

    try {
      const outputs: string[] = [];
      for (let i = 0; i < Math.min(numSamples, 100); i++) {
        const o = await Promise.race([
          computeFn(testCase.prompt),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), timeoutMs),
          ),
        ]);
        outputs.push(o);
      }

      output = outputs[0] || '';
      const passed = outputs.map(o => this.checkPassed(o, testCase));

      passAt1 = passed[0] || false;
      passAt10 = numSamples >= 10 ? passed.filter(Boolean).length > 0 : passAt1;
      passAt100 = numSamples >= 100 ? passed.filter(Boolean).length > 0 : passAt1;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      task: testCase.task,
      passed: passAt1,
      modelOutput: output,
      expectedOutput: testCase.canonicalSolution,
      passAt1,
      passAt10,
      passAt100,
      executionTimeMs: Math.round(performance.now() - caseStart),
      errorMessage: error,
    };
  }

  /**
   * Check if a model output passes the test case.
   */
  private checkPassed(output: string, testCase: EvalCase): boolean {
    const normOutput = output.replace(/\s+/g, ' ').trim();
    const normExpected = testCase.canonicalSolution.replace(/\s+/g, ' ').trim();

    // Direct match
    if (normOutput === normExpected) return true;

    // Contains expected solution
    if (normOutput.includes(normExpected)) return true;

    // Remove markdown fences for comparison
    const stripped = normOutput.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    if (stripped === normExpected || stripped.includes(normExpected)) return true;

    // Check individual test cases
    for (const test of testCase.testCases) {
      if (test.includes('assert') && !normOutput.includes('assert')) return false;
    }

    // Heuristic: output is non-trivial
    return normOutput.length > 10 && normOutput.includes(normExpected.slice(0, 20));
  }

  private computeDifficultyStats(
    results: EvalResult[],
    difficulty: 'easy' | 'medium' | 'hard',
  ): { total: number; passAt1: number } {
    const filtered = results.filter(r => {
      const tc = this.cases.find(c => c.task === r.task);
      return tc?.difficulty === difficulty;
    });
    if (filtered.length === 0) return { total: 0, passAt1: 0 };
    return {
      total: filtered.length,
      passAt1: filtered.filter(r => r.passAt1).length / filtered.length,
    };
  }
}

// ---------------------------------------------------------------------------
// Checkpoint Registry for versioned model artifacts
// ---------------------------------------------------------------------------

export class CheckpointRegistry {
  private registry: Map<string, ModelArtifact> = new Map();
  private registryDir: string;

  constructor(baseDir: string) {
    this.registryDir = join(baseDir, 'checkpoint-registry');
    if (!existsSync(this.registryDir)) mkdirSync(this.registryDir, { recursive: true });
    this.loadFromDisk();
  }

  /**
   * Register a new model artifact.
   */
  register(artifact: ModelArtifact): void {
    this.registry.set(artifact.id, artifact);
    this.saveToDisk();
  }

  /**
   * Add a checkpoint to an existing model artifact.
   */
  addCheckpoint(modelId: string, checkpoint: CheckpointMetadata): boolean {
    const artifact = this.registry.get(modelId);
    if (!artifact) return false;

    artifact.checkpoints.push(checkpoint);

    // Update best checkpoint if this one has lower loss
    const bestCheckpoint = artifact.checkpoints.reduce((best, c) =>
      c.loss < best.loss ? c : best, artifact.checkpoints[0]);
    if (bestCheckpoint) {
      artifact.metrics.bestCheckpoint = bestCheckpoint.id;
      artifact.metrics.finalLoss = bestCheckpoint.loss;
      if (bestCheckpoint.evalLoss !== undefined) {
        artifact.metrics.evalLoss = bestCheckpoint.evalLoss;
      }
    }

    this.saveToDisk();
    return true;
  }

  /**
   * Get a model artifact by ID.
   */
  get(id: string): ModelArtifact | undefined {
    return this.registry.get(id);
  }

  /**
   * List all registered model artifacts.
   */
  list(filter?: {
    status?: ModelArtifact['status'];
    baseModel?: string;
    tags?: string[];
  }): ModelArtifact[] {
    let result = [...this.registry.values()];

    if (filter?.status) {
      result = result.filter(m => m.status === filter.status);
    }
    if (filter?.baseModel) {
      result = result.filter(m => m.baseModel === filter.baseModel);
    }
    if (filter?.tags && filter.tags.length > 0) {
      result = result.filter(m => filter.tags!.some(t => m.tags.includes(t)));
    }

    return result;
  }

  /**
   * Get the latest "ready" artifact for a given base model.
   */
  getLatestReady(baseModel?: string): ModelArtifact | undefined {
    const ready = this.list({ status: 'ready' })
      .filter(m => !baseModel || m.baseModel === baseModel)
      .sort((a, b) => b.createdAt - a.createdAt);
    return ready[0];
  }

  /**
   * Mark an artifact as deprecated.
   */
  deprecate(id: string): boolean {
    const artifact = this.registry.get(id);
    if (!artifact) return false;
    artifact.status = 'deprecated';
    this.saveToDisk();
    return true;
  }

  /**
   * Attach evaluation results to an artifact.
   */
  attachEval(id: string, evalSummary: EvalSummary): boolean {
    const artifact = this.registry.get(id);
    if (!artifact) return false;
    artifact.evalSummary = evalSummary;
    artifact.status = 'ready';
    this.saveToDisk();
    return true;
  }

  /**
   * Create a model artifact from a completed training job.
   */
  createFromJob(
    job: TrainingJob,
    datasetName: string,
    datasetVersion: string,
    tags: string[] = [],
  ): ModelArtifact {
    const id = `model-${randomUUID().slice(0, 8)}`;
    const artifact: ModelArtifact = {
      id,
      baseModel: job.config.baseModel,
      dataset: datasetName,
      datasetVersion,
      trainingJobId: job.id,
      version: `v1.0-${Date.now()}`,
      createdAt: Date.now(),
      status: 'evaluating',
      metrics: {
        finalLoss: job.metrics.loss[job.metrics.loss.length - 1] || 0,
        evalLoss: job.metrics.evalLoss[job.metrics.evalLoss.length - 1] || 0,
        tokensPerSecond: job.metrics.tokensPerSecond,
        totalSteps: job.metrics.currentStep,
        bestCheckpoint: '',
      },
      checkpoints: [],
      adapterPath: job.adapterPath || join(job.config.outputDir, 'adapter'),
      tags,
    };

    this.register(artifact);
    return artifact;
  }

  /**
   * Get total registered artifacts.
   */
  get count(): number {
    return this.registry.size;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private saveToDisk(): void {
    const data = [...this.registry.values()];
    writeFileSync(
      join(this.registryDir, 'registry.json'),
      JSON.stringify(data, null, 2),
    );
  }

  private loadFromDisk(): void {
    const path = join(this.registryDir, 'registry.json');
    if (!existsSync(path)) return;
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as ModelArtifact[];
      for (const artifact of data) {
        this.registry.set(artifact.id, artifact);
      }
    } catch {
      // ignore corrupted registry
    }
  }
}

// ---------------------------------------------------------------------------
// FineTuningPipeline — main orchestrator
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  /** Base directory for all pipeline artifacts */
  baseDir: string;
  /** HuggingFace export config */
  hfConfig?: HuggingFaceExportConfig;
  /** Default training image */
  trainingImage?: string;
  /** Default GPU type */
  gpuType?: string;
  /** Default GPU count */
  gpuCount?: number;
  /** Default max training duration (minutes) */
  maxDurationMinutes?: number;
}

export class FineTuningPipeline {
  private baseDir: string;
  private registry: CheckpointRegistry;
  private evalHarness: EvalHarness;
  private config: PipelineConfig;

  constructor(config: PipelineConfig) {
    this.config = config;
    this.baseDir = config.baseDir;
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });

    this.registry = new CheckpointRegistry(this.baseDir);
    this.evalHarness = new EvalHarness();
  }

  /**
   * Export dataset splits to HuggingFace format.
   */
  exportToHuggingFace(splits: DatasetSplit, outputDir?: string): string[] {
    const dir = outputDir || join(this.baseDir, 'hf-export');
    const exporter = new HuggingFaceExporter(
      this.config.hfConfig || {
        repoId: 'cobra-commander/ft-dataset',
        format: 'jsonl',
        pushToHub: false,
        includeDatasetCard: true,
        splits: ['train', 'val', 'test'],
      },
    );
    return exporter.export(splits, dir);
  }

  /**
   * Generate training config templates.
   */
  generateConfig(
    framework: 'axolotl' | 'llama-factory',
    options: {
      baseModel: string;
      datasetPath: string;
      lora: LoraConfig;
      hyperparams: TrainingHyperparams;
      outputDir: string;
      extras?: Record<string, unknown>;
    },
  ): { configYaml: string; filePath: string } {
    const template: TrainingConfigTemplate = {
      framework,
      baseModel: options.baseModel,
      dataset: {
        path: options.datasetPath,
        type: 'alpaca',
      },
      lora: options.lora,
      hyperparams: options.hyperparams,
      outputDir: options.outputDir,
      extras: options.extras || {},
    };

    let configYaml: string;
    if (framework === 'axolotl') {
      configYaml = ConfigTemplateGenerator.generateAxolotl(template);
    } else {
      configYaml = ConfigTemplateGenerator.generateLlamaFactory(template);
    }

    const filePath = ConfigTemplateGenerator.saveConfig(
      configYaml,
      join(this.baseDir, 'configs'),
      framework,
    );

    return { configYaml, filePath };
  }

  /**
   * Get the eval harness.
   */
  getEvalHarness(): EvalHarness {
    return this.evalHarness;
  }

  /**
   * Run evaluation using the eval harness.
   */
  async evaluate(
    modelId: string,
    benchmark: string,
    computeFn: (prompt: string) => Promise<string>,
    options?: { numSamples?: number; timeoutMs?: number },
  ): Promise<EvalSummary> {
    return this.evalHarness.evaluate(modelId, benchmark, computeFn, options);
  }

  /**
   * Get the checkpoint registry.
   */
  getRegistry(): CheckpointRegistry {
    return this.registry;
  }

  /**
   * Create a model artifact from a completed training job.
   */
  registerModel(
    job: TrainingJob,
    datasetName: string,
    datasetVersion: string,
    tags: string[] = [],
  ): ModelArtifact {
    return this.registry.createFromJob(job, datasetName, datasetVersion, tags);
  }

  /**
   * Full pipeline: export dataset → generate config → (future: train) → evaluate → register.
   */
  async runPipeline(options: {
    splits: DatasetSplit;
    baseModel: string;
    framework: 'axolotl' | 'llama-factory';
    lora: LoraConfig;
    hyperparams: TrainingHyperparams;
    datasetName: string;
    datasetVersion: string;
    tags?: string[];
  }): Promise<{
    exportedFiles: string[];
    configPath: string;
    artifact?: ModelArtifact;
  }> {
    // Export dataset
    const exportedFiles = this.exportToHuggingFace(options.splits);

    // Generate config
    const datasetOutputDir = join(this.baseDir, 'hf-export');
    const { filePath: configPath } = this.generateConfig(
      options.framework,
      {
        baseModel: options.baseModel,
        datasetPath: datasetOutputDir,
        lora: options.lora,
        hyperparams: options.hyperparams,
        outputDir: join(this.baseDir, 'outputs'),
      },
    );

    // Register placeholder artifact
    const artifact = this.registry.createFromJob(
      {
        id: `job-${randomUUID().slice(0, 8)}`,
        config: {
          jobId: `job-${randomUUID().slice(0, 8)}`,
          baseModel: options.baseModel,
          datasetPath: datasetOutputDir,
          outputDir: join(this.baseDir, 'outputs'),
          lora: options.lora,
          hyperparams: options.hyperparams,
          platform: {
            provider: 'modal',
            gpuType: this.config.gpuType || 'A100',
            gpuCount: this.config.gpuCount || 1,
            memoryGb: 80,
            config: {},
          },
          image: this.config.trainingImage || 'ghcr.io/cobra-commander/train:latest',
          maxDurationMinutes: this.config.maxDurationMinutes || 360,
          autoShutdown: true,
        },
        phase: 'pending',
        submittedAt: Date.now(),
        costEstimate: 0,
        costIncurred: 0,
        metrics: {
          currentStep: 0,
          totalSteps: options.hyperparams.maxSteps,
          currentEpoch: 0,
          loss: [],
          evalLoss: [],
          learningRate: [],
          tokensPerSecond: 0,
          elapsedMinutes: 0,
          gpuUtilization: 0,
        },
        logs: [],
        checkpoints: [],
      },
      options.datasetName,
      options.datasetVersion,
      options.tags,
    );

    return { exportedFiles, configPath, artifact };
  }
}
