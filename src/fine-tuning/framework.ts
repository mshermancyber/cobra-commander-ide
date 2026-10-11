import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrainingDataSample {
  id: string;
  /** The instruction/prompt */
  instruction: string;
  /** The expected completion/output */
  output: string;
  /** Source file path in the repo */
  sourceFile: string;
  /** Type of sample */
  type: 'code-completion' | 'instruction-following' | 'chat' | 'fim';
  /** Programming language */
  language: string;
  /** Estimated token count */
  tokenCount: number;
  /** Arbitrary metadata */
  metadata: Record<string, string>;
}

export interface Dataset {
  name: string;
  samples: TrainingDataSample[];
  format: 'alpaca' | 'sharegpt' | 'completion' | 'fim' | 'conversational';
  split: 'train' | 'val' | 'test';
  createdAt: number;
  version: string;
  /** Statistics */
  stats: DatasetStats;
}

export interface DatasetStats {
  totalSamples: number;
  totalTokens: number;
  avgTokensPerSample: number;
  languageDistribution: Record<string, number>;
  typeDistribution: Record<string, number>;
}

export interface DatasetSplit {
  train: Dataset;
  val: Dataset;
  test: Dataset;
}

export interface LoraConfig {
  r: number;
  alpha: number;
  dropout: number;
  targetModules: string[];
  bias: 'none' | 'all' | 'lora_only';
  taskType: 'CAUSAL_LM' | 'SEQ_CLS' | 'TOKEN_CLS';
  /** Additional PEFT settings */
  useRsLora: boolean;
  useDoRA: boolean;
  layersToTransform?: number[];
}

export interface TrainingJobConfig {
  /** Unique job identifier */
  jobId: string;
  /** Base model name (HuggingFace ID or local path) */
  baseModel: string;
  /** Dataset path */
  datasetPath: string;
  /** Output directory for checkpoints and adapters */
  outputDir: string;
  /** LoRA hyperparameters */
  lora: LoraConfig;
  /** Training hyperparameters */
  hyperparams: TrainingHyperparams;
  /** GPU platform */
  platform: GpuPlatform;
  /** Container image for training */
  image: string;
  /** Max duration in minutes before auto-shutdown */
  maxDurationMinutes: number;
  /** Whether to auto-shutdown after training */
  autoShutdown: boolean;
}

export interface TrainingHyperparams {
  epochs: number;
  batchSize: number;
  gradientAccumulationSteps: number;
  learningRate: number;
  warmupSteps: number;
  maxSteps: number;
  saveSteps: number;
  evalSteps: number;
  loggingSteps: number;
  fp16: boolean;
  bf16: boolean;
  optim: string;
  lrScheduler: 'cosine' | 'linear' | 'constant' | 'cosine_with_restarts';
  weightDecay: number;
  maxGradNorm: number;
  seed: number;
  /** Sequence length limit */
  maxSeqLength: number;
}

export interface GpuPlatform {
  provider: 'modal' | 'runpod' | 'lambda' | 'vastai' | 'local';
  gpuType: string;
  gpuCount: number;
  memoryGb: number;
  /** Provider-specific configuration */
  config: Record<string, string>;
}

export type JobPhase = 'pending' | 'provisioning' | 'running' | 'evaluating' | 'completed' | 'failed' | 'cancelled';

export interface TrainingJob {
  id: string;
  config: TrainingJobConfig;
  phase: JobPhase;
  platformJobId?: string;
  submittedAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Cost estimate in USD */
  costEstimate: number;
  /** Current cost incurred */
  costIncurred: number;
  /** Training metrics snapshot */
  metrics: TrainingMetrics;
  /** Log lines */
  logs: string[];
  /** Checkpoint paths */
  checkpoints: string[];
  /** Final adapter path */
  adapterPath?: string;
  /** Error message if failed */
  errorMessage?: string;
}

export interface TrainingMetrics {
  currentStep: number;
  totalSteps: number;
  currentEpoch: number;
  loss: number[];
  evalLoss: number[];
  learningRate: number[];
  tokensPerSecond: number;
  elapsedMinutes: number;
  gpuUtilization: number;
}

export interface ExtractionOptions {
  includeComments: boolean;
  includeTests: boolean;
  includeDocs: boolean;
  minSampleLength: number;
  maxSamplesPerFile: number;
  supportedExtensions: string[];
  excludePatterns: string[];
  /** Extract context from git history if available */
  useGitHistory: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_EXTRACTION_OPTIONS: ExtractionOptions = {
  includeComments: true,
  includeTests: false,
  includeDocs: false,
  minSampleLength: 10,
  maxSamplesPerFile: 50,
  supportedExtensions: ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.cs', '.rb', '.swift'],
  excludePatterns: ['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'target', '.next'],
  useGitHistory: true,
};

const DEFAULT_HYPERPARAMS: TrainingHyperparams = {
  epochs: 3,
  batchSize: 4,
  gradientAccumulationSteps: 8,
  learningRate: 2e-4,
  warmupSteps: 100,
  maxSteps: 1000,
  saveSteps: 200,
  evalSteps: 200,
  loggingSteps: 10,
  fp16: true,
  bf16: false,
  optim: 'adamw_8bit',
  lrScheduler: 'cosine',
  weightDecay: 0.01,
  maxGradNorm: 1.0,
  seed: 42,
  maxSeqLength: 2048,
};

// ---------------------------------------------------------------------------
// Dataset Builder — instruction/completion pairs from codebase history
// ---------------------------------------------------------------------------

export class DatasetBuilder {
  private options: ExtractionOptions;

  constructor(options?: Partial<ExtractionOptions>) {
    this.options = { ...DEFAULT_EXTRACTION_OPTIONS, ...options };
  }

  /**
   * Extract training samples from a repository directory.
   * Walks the file tree, extracts instruction/completion pairs from source files.
   */
  extractFromRepo(repoPath: string): TrainingDataSample[] {
    const samples: TrainingDataSample[] = [];
    if (!existsSync(repoPath)) return samples;
    this.walkDirectory(repoPath, repoPath, samples);
    return samples;
  }

  /**
   * Extract samples from a single file.
   */
  extractFromFile(filePath: string): TrainingDataSample[] {
    if (!existsSync(filePath)) return [];
    const ext = extname(filePath).toLowerCase();
    if (!this.options.supportedExtensions.includes(ext)) return [];

    try {
      const content = readFileSync(filePath, 'utf-8');
      return this.extractSamples(filePath, content, ext);
    } catch {
      return [];
    }
  }

  /**
   * Extract samples from raw text content.
   */
  extractFromContent(content: string, filePath: string, language: string): TrainingDataSample[] {
    return this.extractSamples(filePath, content, `.${language}`);
  }

  /**
   * Build a complete dataset with train/val/test split from samples.
   */
  buildDataset(
    samples: TrainingDataSample[],
    config: {
      name?: string;
      trainRatio?: number;
      valRatio?: number;
      testRatio?: number;
      seed?: number;
      format?: Dataset['format'];
    } = {},
  ): DatasetSplit {
    const {
      name = 'custom-fine-tuning-dataset',
      trainRatio = 0.8,
      valRatio = 0.1,
      seed = 42,
      format = 'alpaca',
    } = config;

    const shuffled = this.seededShuffle(samples, seed);
    const total = shuffled.length;
    const trainEnd = Math.floor(total * trainRatio);
    const valEnd = Math.floor(total * (trainRatio + valRatio));
    const now = Date.now();
    const version = `v1.0-${now}`;

    const trainSamples = shuffled.slice(0, trainEnd);
    const valSamples = shuffled.slice(trainEnd, valEnd);
    const testSamples = shuffled.slice(valEnd);

    return {
      train: this.makeDataset(`${name}-train`, trainSamples, format, 'train', now, version),
      val: this.makeDataset(`${name}-val`, valSamples, format, 'val', now, version),
      test: this.makeDataset(`${name}-test`, testSamples, format, 'test', now, version),
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private walkDirectory(basePath: string, currentPath: string, samples: TrainingDataSample[]): void {
    if (samples.length >= 10_000) return; // safety cap

    let entries: any[];
    try {
      entries = readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      const relPath = relative(basePath, fullPath);

      if (this.options.excludePatterns.some(p => relPath.includes(p))) continue;

      if (entry.isDirectory()) {
        this.walkDirectory(basePath, fullPath, samples);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (this.options.supportedExtensions.includes(ext)) {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            samples.push(...this.extractSamples(relPath, content, ext));
          } catch {
            // skip unreadable
          }
        }
      }
    }
  }

  private extractSamples(filePath: string, content: string, ext: string): TrainingDataSample[] {
    const samples: TrainingDataSample[] = [];
    const language = this.detectLanguage(ext);
    const lines = content.split('\n');

    // 1. Code-completion pairs: prefix → next lines
    for (let i = 1; i < lines.length; i++) {
      if (samples.length >= this.options.maxSamplesPerFile) break;

      const prefix = lines.slice(0, i).join('\n');
      const completion = lines.slice(i, Math.min(i + 10, lines.length)).join('\n');

      if (prefix.length < this.options.minSampleLength || completion.trim().length === 0) continue;

      samples.push({
        id: `cc-${randomUUID().slice(0, 8)}`,
        instruction: `Complete the following ${language} code:\n\`\`\`${language}\n${prefix}\n\`\`\``,
        output: `\`\`\`${language}\n${completion}\n\`\`\``,
        sourceFile: filePath,
        type: 'code-completion',
        language,
        tokenCount: Math.ceil((prefix.length + completion.length) / 4),
        metadata: { filePath, language, line: String(i) },
      });
    }

    // 2. Instruction-following pairs: comment → next code block
    if (this.options.includeComments) {
      for (let i = 0; i < lines.length; i++) {
        if (samples.length >= this.options.maxSamplesPerFile) break;

        const line = lines[i].trim();
        const commentMatch = line.match(/\/\/\s*(.+)/) || line.match(/#\s*(.+)/) || line.match(/\/\*\*\s*(.+)/);
        if (!commentMatch) continue;

        const comment = commentMatch[1].replace(/\*\/$/, '').trim();
        const nextCodeLines: string[] = [];
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const nl = lines[j].trim();
          if (nl && !nl.startsWith('//') && !nl.startsWith('#') && !nl.startsWith('/*') && !nl.startsWith('*')) {
            nextCodeLines.push(nl);
          }
        }

        if (nextCodeLines.length > 0 && comment.length > 5) {
          samples.push({
            id: `if-${randomUUID().slice(0, 8)}`,
            instruction: comment,
            output: nextCodeLines.join('\n'),
            sourceFile: filePath,
            type: 'instruction-following',
            language,
            tokenCount: Math.ceil((comment.length + nextCodeLines.join('\n').length) / 4),
            metadata: { filePath, language, lineNumber: String(i + 1) },
          });
        }
      }
    }

    return samples;
  }

  private detectLanguage(ext: string): string {
    const map: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript',
      '.js': 'javascript', '.jsx': 'javascript',
      '.py': 'python',
      '.rs': 'rust',
      '.go': 'go',
      '.java': 'java',
      '.cs': 'csharp',
      '.rb': 'ruby',
      '.swift': 'swift',
    };
    return map[ext] || 'text';
  }

  private makeDataset(
    name: string,
    samples: TrainingDataSample[],
    format: Dataset['format'],
    split: Dataset['split'],
    createdAt: number,
    version: string,
  ): Dataset {
    const totalTokens = samples.reduce((sum, s) => sum + s.tokenCount, 0);
    const langDist: Record<string, number> = {};
    const typeDist: Record<string, number> = {};
    for (const s of samples) {
      langDist[s.language] = (langDist[s.language] || 0) + 1;
      typeDist[s.type] = (typeDist[s.type] || 0) + 1;
    }

    return {
      name,
      samples,
      format,
      split,
      createdAt,
      version,
      stats: {
        totalSamples: samples.length,
        totalTokens,
        avgTokensPerSample: samples.length > 0 ? Math.round(totalTokens / samples.length) : 0,
        languageDistribution: langDist,
        typeDistribution: typeDist,
      },
    };
  }

  private seededShuffle<T>(array: T[], seed: number): T[] {
    const result = [...array];
    let s = seed;
    for (let i = result.length - 1; i > 0; i--) {
      s = (s * 16807 + 0) % 2147483647;
      const j = s % (i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Dataset Formatter — export in various formats
// ---------------------------------------------------------------------------

export class DatasetFormatter {
  /** Format as Alpaca JSON (instruction/input/output) */
  static toAlpaca(dataset: Dataset): string {
    const records = dataset.samples.map(s => ({
      instruction: s.instruction,
      input: '',
      output: s.output,
    }));
    return JSON.stringify(records, null, 2);
  }

  /** Format as ShareGPT conversations */
  static toShareGPT(dataset: Dataset): string {
    const records = dataset.samples.map(s => ({
      conversations: [
        { from: 'human', value: s.instruction },
        { from: 'gpt', value: s.output },
      ],
    }));
    return JSON.stringify(records, null, 2);
  }

  /** Format as FIM (fill-in-the-middle) records */
  static toFim(dataset: Dataset): string {
    const records = dataset.samples
      .filter(s => s.type === 'code-completion' || s.type === 'fim')
      .map(s => {
        const prefixEnd = s.instruction.indexOf('\n```');
        const prefix = prefixEnd > 0
          ? s.instruction.slice(0, prefixEnd).replace(/^Complete the following \w+ code:\n```\w+\n/, '')
          : '';
        return {
          prefix,
          middle: s.output.replace(/^```\w+\n/, '').replace(/\n```$/, ''),
          suffix: '',
        };
      });
    return JSON.stringify(records, null, 2);
  }

  /** Format as JSONL */
  static toJsonl(dataset: Dataset): string {
    return dataset.samples.map(s => JSON.stringify({
      instruction: s.instruction,
      output: s.output,
    })).join('\n');
  }

  /** Save dataset splits to disk */
  static saveToDisk(splits: DatasetSplit, outputDir: string): string[] {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    const files: string[] = [];

    for (const [splitKey, ds] of Object.entries(splits)) {
      const jsonPath = join(outputDir, `${ds.name}.json`);
      writeFileSync(jsonPath, DatasetFormatter.toAlpaca(ds));
      files.push(jsonPath);

      const jsonlPath = join(outputDir, `${ds.name}.jsonl`);
      writeFileSync(jsonlPath, DatasetFormatter.toJsonl(ds));
      files.push(jsonlPath);
    }

    return files;
  }
}

// ---------------------------------------------------------------------------
// LoRA Config Generator
// ---------------------------------------------------------------------------

export class LoraConfigGenerator {
  /** Preset sizes */
  private static readonly SIZE_PRESETS: Record<string, { r: number; alpha: number }> = {
    '7b': { r: 16, alpha: 32 },
    '13b': { r: 16, alpha: 32 },
    '34b': { r: 32, alpha: 64 },
    '70b': { r: 64, alpha: 128 },
    small: { r: 8, alpha: 16 },
    medium: { r: 16, alpha: 32 },
    large: { r: 32, alpha: 64 },
  };

  /** Default target modules for Llama-style architectures */
  private static readonly DEFAULT_TARGETS = [
    'q_proj', 'k_proj', 'v_proj', 'o_proj',
    'gate_proj', 'up_proj', 'down_proj',
  ];

  /**
   * Generate a LoRA config from model size and task.
   */
  static generate(options: {
    modelSize?: string;
    taskType?: LoraConfig['taskType'];
    targetModules?: string[];
    useRsLora?: boolean;
    useDoRA?: boolean;
  } = {}): LoraConfig {
    const preset = LoraConfigGenerator.SIZE_PRESETS[options.modelSize || 'small']
      || LoraConfigGenerator.SIZE_PRESETS.small;

    return {
      r: preset.r,
      alpha: preset.alpha,
      dropout: 0.05,
      targetModules: options.targetModules || [...LoraConfigGenerator.DEFAULT_TARGETS],
      bias: 'none',
      taskType: options.taskType || 'CAUSAL_LM',
      useRsLora: options.useRsLora || false,
      useDoRA: options.useDoRA || false,
    };
  }

  /** Export as Axolotl YAML fragment */
  static toAxolotlYaml(config: LoraConfig): string {
    const lines = [
      `lora_r: ${config.r}`,
      `lora_alpha: ${config.alpha}`,
      `lora_dropout: ${config.dropout}`,
      `lora_target_modules:`,
      ...config.targetModules.map(m => `  - ${m}`),
      `lora_fan_in_fan_out: false`,
      `lora_modules_to_save: []`,
      `use_rslora: ${config.useRsLora}`,
      `use_dora: ${config.useDoRA}`,
    ];
    return lines.join('\n');
  }

  /** Export as Llama-Factory config fragment */
  static toLlamaFactoryConfig(config: LoraConfig): Record<string, unknown> {
    return {
      lora_rank: config.r,
      lora_alpha: config.alpha,
      lora_dropout: config.dropout,
      lora_target: config.targetModules.join(','),
      loraplus_lr_ratio: config.useRsLora ? 0.5 : undefined,
      use_dora: config.useDoRA,
    };
  }
}

// ---------------------------------------------------------------------------
// Training Job Scheduler (launch + poll remote GPU job)
// ---------------------------------------------------------------------------

export interface SchedulerConfig {
  /** Base directory for job artifacts */
  baseDir: string;
  /** Default GPU platform */
  defaultPlatform: GpuPlatform;
  /** Polling interval in seconds */
  pollIntervalSeconds: number;
  /** Max concurrent jobs */
  maxConcurrentJobs: number;
}

export class TrainingJobScheduler {
  private jobs: Map<string, TrainingJob> = new Map();
  private config: SchedulerConfig;
  private pollingTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(config: Partial<SchedulerConfig> = {}) {
    this.config = {
      baseDir: config.baseDir || join(process.cwd(), 'training-jobs'),
      defaultPlatform: config.defaultPlatform || {
        provider: 'modal',
        gpuType: 'A100',
        gpuCount: 1,
        memoryGb: 80,
        config: {},
      },
      pollIntervalSeconds: config.pollIntervalSeconds || 30,
      maxConcurrentJobs: config.maxConcurrentJobs || 4,
    };
    if (!existsSync(this.config.baseDir)) {
      mkdirSync(this.config.baseDir, { recursive: true });
    }
  }

  /**
   * Launch a new training job on a remote GPU.
   */
  async launch(config: Omit<TrainingJobConfig, 'jobId'>): Promise<TrainingJob> {
    const jobId = `job-${randomUUID().slice(0, 8)}`;
    const fullConfig: TrainingJobConfig = { ...config, jobId };

    const job: TrainingJob = {
      id: jobId,
      config: fullConfig,
      phase: 'pending',
      submittedAt: Date.now(),
      costEstimate: this.estimateCost(fullConfig),
      costIncurred: 0,
      metrics: {
        currentStep: 0,
        totalSteps: fullConfig.hyperparams.maxSteps,
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
    };

    this.jobs.set(jobId, job);

    // Submit to the remote platform
    await this.submitToPlatform(job);

    // Start polling
    this.startPolling(jobId);

    return job;
  }

  /**
   * Get a job by ID.
   */
  getJob(id: string): TrainingJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * List all jobs.
   */
  listJobs(phase?: JobPhase): TrainingJob[] {
    const all = [...this.jobs.values()];
    return phase ? all.filter(j => j.phase === phase) : all;
  }

  /**
   * Cancel a running job.
   */
  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.phase === 'completed' || job.phase === 'failed' || job.phase === 'cancelled') {
      return false;
    }

    job.phase = 'cancelled';
    job.completedAt = Date.now();
    this.stopPolling(id);

    // Attempt platform cancellation (best-effort)
    try {
      await this.cancelOnPlatform(job);
    } catch {
      // best-effort
    }

    this.saveJobState(job);
    return true;
  }

  /**
   * Poll job status from the remote platform.
   */
  async poll(id: string): Promise<TrainingJob | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.phase === 'completed' || job.phase === 'failed' || job.phase === 'cancelled') {
      return job;
    }

    try {
      const platformStatus = await this.queryPlatformStatus(job);

      // Update job with platform data
      if (platformStatus.phase) {
        job.phase = platformStatus.phase;
      }
      if (platformStatus.metrics) {
        job.metrics = { ...job.metrics, ...platformStatus.metrics };
      }
      if (platformStatus.logs) {
        job.logs.push(...platformStatus.logs);
      }
      if (platformStatus.checkpoints) {
        job.checkpoints.push(...platformStatus.checkpoints);
      }
      if (platformStatus.adapterPath) {
        job.adapterPath = platformStatus.adapterPath;
      }
      if (platformStatus.cost) {
        job.costIncurred = platformStatus.cost;
      }

      // Mark completion
      if (job.phase === 'completed' || job.phase === 'failed') {
        job.completedAt = Date.now();
        this.stopPolling(id);
        this.saveJobState(job);
      }
    } catch (err) {
      job.logs.push(`[poll error] ${err instanceof Error ? err.message : String(err)}`);
    }

    return job;
  }

  /**
   * Get the scheduler configuration.
   */
  getConfig(): SchedulerConfig {
    return { ...this.config };
  }

  // -----------------------------------------------------------------------
  // Private: platform abstraction
  // -----------------------------------------------------------------------

  private async submitToPlatform(job: TrainingJob): Promise<void> {
    job.phase = 'provisioning';
    job.logs.push(`[${new Date().toISOString()}] Submitting to ${job.config.platform.provider} with ${job.config.platform.gpuCount}x ${job.config.platform.gpuType}`);

    // Simulate platform submission
    job.platformJobId = `${job.config.platform.provider}-${randomUUID().slice(0, 8)}`;
    job.startedAt = Date.now();

    // In production, this would call the Modal/RunPod/Lambda API
    job.phase = 'running';
    job.logs.push(`[${new Date().toISOString()}] Job running: ${job.platformJobId}`);
  }

  private async queryPlatformStatus(job: TrainingJob): Promise<{
    phase?: JobPhase;
    metrics?: Partial<TrainingMetrics>;
    logs?: string[];
    checkpoints?: string[];
    adapterPath?: string;
    cost?: number;
  }> {
    // Simulated platform query
    // In production, this would call Modal's /jobs/{id} or RunPod's /status/{id}
    const elapsedMs = Date.now() - (job.startedAt || Date.now());

    // Simulate progress
    const progress = Math.min(elapsedMs / (job.config.maxDurationMinutes * 60_000), 0.99);
    const step = Math.floor(progress * job.config.hyperparams.maxSteps);

    return {
      phase: progress >= 0.99 ? 'completed' : 'running',
      metrics: {
        currentStep: step,
        loss: [2.5 - progress * 2.0 + (Math.random() - 0.5) * 0.2],
        tokensPerSecond: 1200 + Math.random() * 400,
        elapsedMinutes: elapsedMs / 60_000,
        gpuUtilization: 85 + Math.random() * 10,
      },
      logs: [`Step ${step}/${job.config.hyperparams.maxSteps} | loss=${(2.5 - progress * 2.0).toFixed(4)}`],
    };
  }

  private async cancelOnPlatform(job: TrainingJob): Promise<void> {
    // In production, call platform cancel endpoint
    job.logs.push(`[${new Date().toISOString()}] Cancelled on ${job.config.platform.provider}`);
  }

  private startPolling(jobId: string): void {
    if (this.pollingTimers.has(jobId)) return;
    const intervalMs = this.config.pollIntervalSeconds * 1000;
    const timer = setInterval(() => {
      this.poll(jobId);
    }, intervalMs);
    this.pollingTimers.set(jobId, timer);
  }

  private stopPolling(jobId: string): void {
    const timer = this.pollingTimers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.pollingTimers.delete(jobId);
    }
  }

  private estimateCost(config: TrainingJobConfig): number {
    const rates: Record<string, number> = {
      'A100': 2.50, 'H100': 3.50, 'A6000': 1.25,
      '4090': 0.75, '3090': 0.55, 'V100': 1.80,
      'A10': 0.90, 'T4': 0.40, 'L40S': 1.50,
    };
    const rate = rates[config.platform.gpuType] || 1.0;
    return rate * config.platform.gpuCount * (config.maxDurationMinutes / 60);
  }

  private saveJobState(job: TrainingJob): void {
    const jobDir = join(this.config.baseDir, job.id);
    if (!existsSync(jobDir)) mkdirSync(jobDir, { recursive: true });
    try {
      writeFileSync(join(jobDir, 'job.json'), JSON.stringify(job, null, 2));
    } catch {
      // best-effort
    }
  }

  /**
   * Shutdown the scheduler, cancelling all polling.
   */
  shutdown(): void {
    for (const [id] of this.pollingTimers) {
      this.stopPolling(id);
    }
  }
}

// ---------------------------------------------------------------------------
// FineTuningFramework — main orchestrator
// ---------------------------------------------------------------------------

export class FineTuningFramework {
  private datasetBuilder: DatasetBuilder;
  private scheduler: TrainingJobScheduler;
  private repoPath: string;

  constructor(
    repoPath: string,
    options?: {
      extractionOptions?: Partial<ExtractionOptions>;
      schedulerConfig?: Partial<SchedulerConfig>;
    },
  ) {
    this.repoPath = repoPath;
    this.datasetBuilder = new DatasetBuilder(options?.extractionOptions);
    this.scheduler = new TrainingJobScheduler(options?.schedulerConfig);
  }

  /**
   * Extract training samples from the repository.
   */
  extractTrainingData(): TrainingDataSample[] {
    return this.datasetBuilder.extractFromRepo(this.repoPath);
  }

  /**
   * Build a dataset with train/val/test split.
   */
  buildDataset(
    samples: TrainingDataSample[],
    config?: {
      name?: string;
      trainRatio?: number;
      valRatio?: number;
      testRatio?: number;
      seed?: number;
    },
  ): DatasetSplit {
    return this.datasetBuilder.buildDataset(samples, config);
  }

  /**
   * Save dataset splits to disk.
   */
  saveDataset(splits: DatasetSplit, outputDir: string): string[] {
    return DatasetFormatter.saveToDisk(splits, outputDir);
  }

  /**
   * Generate LoRA configuration for a given model size.
   */
  generateLoraConfig(options?: {
    modelSize?: string;
    taskType?: LoraConfig['taskType'];
    targetModules?: string[];
  }): LoraConfig {
    return LoraConfigGenerator.generate(options);
  }

  /**
   * Create default training hyperparameters.
   */
  getDefaultHyperparams(overrides?: Partial<TrainingHyperparams>): TrainingHyperparams {
    return { ...DEFAULT_HYPERPARAMS, ...overrides };
  }

  /**
   * Launch a training job.
   */
  async launchTraining(config: Omit<TrainingJobConfig, 'jobId'>): Promise<TrainingJob> {
    return this.scheduler.launch(config);
  }

  /**
   * Poll a training job for status updates.
   */
  async pollJob(jobId: string): Promise<TrainingJob | undefined> {
    return this.scheduler.poll(jobId);
  }

  /**
   * Cancel a training job.
   */
  async cancelJob(jobId: string): Promise<boolean> {
    return this.scheduler.cancel(jobId);
  }

  /**
   * Get the job scheduler.
   */
  getScheduler(): TrainingJobScheduler {
    return this.scheduler;
  }

  /**
   * Get the dataset builder.
   */
  getDatasetBuilder(): DatasetBuilder {
    return this.datasetBuilder;
  }

  /**
   * Full pipeline: extract → build → save → launch.
   */
  async runFullPipeline(options: {
    model: string;
    outputDir: string;
    datasetName?: string;
    modelSize?: string;
    gpuType?: string;
    gpuCount?: number;
    image?: string;
    hyperparams?: Partial<TrainingHyperparams>;
    maxDurationMinutes?: number;
  }): Promise<{
    samples: TrainingDataSample[];
    splits: DatasetSplit;
    savedFiles: string[];
    job: TrainingJob;
    lora: LoraConfig;
  }> {
    // Extract
    const samples = this.extractTrainingData();

    // Build dataset
    const splits = this.buildDataset(samples, {
      name: options.datasetName || 'ft-dataset',
    });

    // Save
    const savedFiles = this.saveDataset(splits, options.outputDir);

    // LoRA
    const lora = this.generateLoraConfig({ modelSize: options.modelSize });

    // Launch
    const job = await this.launchTraining({
      baseModel: options.model,
      datasetPath: join(options.outputDir, `${options.datasetName || 'ft-dataset'}-train.json`),
      outputDir: join(options.outputDir, 'outputs'),
      lora,
      hyperparams: this.getDefaultHyperparams(options.hyperparams),
      platform: {
        provider: 'modal',
        gpuType: options.gpuType || 'A100',
        gpuCount: options.gpuCount || 1,
        memoryGb: 80,
        config: {},
      },
      image: options.image || 'ghcr.io/cobra-commander/train:latest',
      maxDurationMinutes: options.maxDurationMinutes || 360,
      autoShutdown: true,
    });

    return { samples, splits, savedFiles, job, lora };
  }

  /**
   * Shutdown: stop all polling.
   */
  shutdown(): void {
    this.scheduler.shutdown();
  }
}
