export interface ProgressReport {
  taskId: string;
  elapsed: number;
  turnsUsed: number;
  maxTurns: number;
  toolCallCount: number;
  filesRead: string[];
  filesWritten: string[];
  lastAction: string;
  status: 'running' | 'verifying' | 'retrying' | 'done' | 'failed';
}

export interface ProgressReporterOptions {
  intervalMs: number;
  enabled: boolean;
  onReport: (report: ProgressReport) => void;
}

export interface ProgressReporter {
  start(taskId: string): void;
  update(data: Partial<ProgressReport>): void;
  recordToolCall(name: string, input: Record<string, unknown>): void;
  stop(): void;
}

export function createProgressReporter(options: ProgressReporterOptions): ProgressReporter {
  let timer: ReturnType<typeof setInterval> | null = null;
  let startTime = 0;

  const report: ProgressReport = {
    taskId: '',
    elapsed: 0,
    turnsUsed: 0,
    maxTurns: 0,
    toolCallCount: 0,
    filesRead: [],
    filesWritten: [],
    lastAction: '',
    status: 'running',
  };

  function emit(): void {
    report.elapsed = Math.round((Date.now() - startTime) / 1000);
    options.onReport({ ...report, filesRead: [...report.filesRead], filesWritten: [...report.filesWritten] });
  }

  return {
    start(taskId: string): void {
      report.taskId = taskId;
      report.elapsed = 0;
      report.turnsUsed = 0;
      report.toolCallCount = 0;
      report.filesRead = [];
      report.filesWritten = [];
      report.lastAction = '';
      report.status = 'running';
      startTime = Date.now();

      if (options.enabled && options.intervalMs > 0) {
        timer = setInterval(() => emit(), options.intervalMs);
      }
    },

    update(data: Partial<ProgressReport>): void {
      Object.assign(report, data);
    },

    recordToolCall(name: string, input: Record<string, unknown>): void {
      report.toolCallCount++;
      const path = (input.path as string) || '';
      if (name === 'read_file' && path && !report.filesRead.includes(path)) {
        report.filesRead.push(path);
      }
      if ((name === 'write_file' || name === 'edit_file' || name === 'patch_file') && path && !report.filesWritten.includes(path)) {
        report.filesWritten.push(path);
      }
      if (name === 'run_command') {
        report.lastAction = `$ ${(input.command as string || '').slice(0, 80)}`;
      } else if (path) {
        report.lastAction = `${name}: ${path}`;
      } else {
        report.lastAction = name;
      }
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      report.elapsed = Math.round((Date.now() - startTime) / 1000);
      if (report.status === 'running') {
        report.status = 'done';
      }
      emit();
    },
  };
}
