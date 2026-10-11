import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  createReadStream,
  watch,
} from 'node:fs';
import { join, relative, basename, extname, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: Date;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'UNKNOWN';
  service: string;
  message: string;
  raw: string;
  source: string;
  line: number;
  traceId?: string;
  spanId?: string;
  metadata?: Record<string, string>;
}

export interface LogQuery {
  services?: string[];
  levels?: LogEntry['level'][];
  startTime?: Date;
  endTime?: Date;
  searchPattern?: string | RegExp;
  traceId?: string;
  maxResults?: number;
  contextLines?: number;
}

export interface AggregatedLogs {
  query: LogQuery;
  entries: LogEntry[];
  totalMatches: number;
  byService: Map<string, LogEntry[]>;
  byLevel: Map<string, LogEntry[]>;
  timeline: Array<{ timestamp: Date; count: number; entries: LogEntry[] }>;
  errorRate: number;
  durationMs: number;
}

export interface TimeSeriesPoint {
  timestamp: Date;
  value: number;
  label?: string;
}

export interface AnomalyResult {
  metricName: string;
  dataPoints: TimeSeriesPoint[];
  mean: number;
  stdDev: number;
  zScores: Array<{ index: number; timestamp: Date; value: number; zScore: number }>;
  anomalies: Array<{ index: number; timestamp: Date; value: number; zScore: number; severity: 'low' | 'medium' | 'high' | 'critical' }>;
  threshold: number;
  detected: boolean;
}

export interface DeployEvent {
  timestamp: Date;
  service: string;
  version: string;
  commit: string;
  author: string;
  status: 'success' | 'failed' | 'rolling-back';
  environment: string;
}

export interface AlertEvent {
  timestamp: Date;
  id: string;
  service: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  source: string;
  status: 'firing' | 'resolved';
}

export interface IncidentEvent {
  type: 'deploy' | 'alert' | 'log-error' | 'log-warn' | 'metric-anomaly' | 'manual';
  timestamp: Date;
  source: string;
  detail: string;
  data: Record<string, unknown>;
}

export interface IncidentTimeline {
  id: string;
  title: string;
  events: IncidentEvent[];
  startTime: Date;
  endTime: Date;
  services: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  rootCauseHypotheses: RootCauseHypothesis[];
  correlated: boolean;
}

export interface RootCauseHypothesis {
  id: string;
  hypothesis: string;
  confidence: number; // 0-1
  supportingEvidence: string[];
  contradictingEvidence: string[];
  suggestedActions: string[];
  relatedEvents: number[];
}

export interface InvestigationReport {
  id: string;
  generatedAt: Date;
  timeline: IncidentTimeline;
  anomalies: AnomalyResult[];
  aggregatedLogs: AggregatedLogs | null;
  summary: string;
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Log Aggregator — GAP-101: tail + grep across service logs
// ---------------------------------------------------------------------------

export class LogAggregator {
  /**
   * Parse a single log line into a structured entry.
   * Supports common formats: ISO 8601, syslog, JSON, logfmt.
   */
  parseLine(line: string, source: string, lineNumber: number): LogEntry | null {
    if (!line.trim()) return null;

    // Try JSON log line first
    if (line.trim().startsWith('{')) {
      try {
        const obj = JSON.parse(line);
        return {
          timestamp: obj.timestamp ? new Date(obj.timestamp) : new Date(),
          level: this.normalizeLevel(obj.level || obj.severity || 'INFO'),
          service: obj.service || obj.app || obj.source || basename(source),
          message: obj.message || obj.msg || JSON.stringify(obj),
          raw: line,
          source,
          line: lineNumber,
          traceId: obj.traceId || obj.trace_id || obj.trace,
          spanId: obj.spanId || obj.span_id || obj.span,
          metadata: obj,
        };
      } catch { /* fall through to regex parsing */ }
    }

    // ISO 8601: 2024-01-15T10:30:00.000Z [ERROR] [service] message
    const isoMatch = line.match(
      /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*\[?(\w+)\]?\s*\[?(\w+)\]?\s*(.+)/
    );
    if (isoMatch) {
      return {
        timestamp: new Date(isoMatch[1]),
        level: this.normalizeLevel(isoMatch[2]),
        service: isoMatch[3].replace(/[\[\]]/g, ''),
        message: isoMatch[4].trim(),
        raw: line,
        source,
        line: lineNumber,
      };
    }

    // Syslog: Jan 15 10:30:00 hostname service[pid]: message
    const syslogMatch = line.match(
      /(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s+(.+)/
    );
    if (syslogMatch) {
      return {
        timestamp: this.parseSyslogDate(syslogMatch[1]),
        level: 'INFO',
        service: syslogMatch[3],
        message: syslogMatch[5].trim(),
        raw: line,
        source,
        line: lineNumber,
      };
    }

    // Logfmt/structured: level=ERROR service=api message="something went wrong"
    const logfmtMatch = line.match(/level=(\w+)/i);
    if (logfmtMatch) {
      const level = logfmtMatch[1];
      const serviceMatch = line.match(/service=(\w+)/i);
      const msgMatch = line.match(/msg="([^"]*)"|message="([^"]*)"|msg=(\S+)/i);
      return {
        timestamp: new Date(),
        level: this.normalizeLevel(level),
        service: serviceMatch ? serviceMatch[1] : basename(source),
        message: msgMatch ? (msgMatch[1] || msgMatch[2] || msgMatch[3] || line) : line,
        raw: line,
        source,
        line: lineNumber,
      };
    }

    // Plain text fallback: try to detect level from content
    const upper = line.toUpperCase();
    let level: LogEntry['level'] = 'INFO';
    if (upper.includes('FATAL') || upper.includes('CRITICAL')) level = 'FATAL';
    else if (upper.includes('ERROR') || upper.includes('FAIL') || upper.includes('EXCEPTION')) level = 'ERROR';
    else if (upper.includes('WARN')) level = 'WARN';
    else if (upper.includes('DEBUG') || upper.includes('TRACE')) level = 'DEBUG';

    return {
      timestamp: new Date(),
      level,
      service: basename(source),
      message: line,
      raw: line,
      source,
      line: lineNumber,
    };
  }

  /**
   * Read and parse a log file into structured entries.
   */
  async readLogFile(filePath: string, maxLines = 100_000): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    if (!existsSync(filePath)) return entries;

    return new Promise((resolve, reject) => {
      const rl = createInterface({
        input: createReadStream(filePath, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
      });

      let lineNumber = 0;
      rl.on('line', (line) => {
        if (entries.length >= maxLines) return;
        lineNumber++;
        const entry = this.parseLine(line, filePath, lineNumber);
        if (entry) entries.push(entry);
      });

      rl.on('close', () => resolve(entries));
      rl.on('error', reject);
    });
  }

  /**
   * Aggregate logs from multiple services based on a query.
   */
  async aggregate(logDirs: string[], query: LogQuery): Promise<AggregatedLogs> {
    const startTime = Date.now();
    const allEntries: LogEntry[] = [];

    // Collect log files from directories
    for (const dir of logDirs) {
      if (!existsSync(dir)) continue;
      const logFiles = this.findLogFiles(dir, query.services);
      for (const file of logFiles) {
        const entries = await this.readLogFile(file, query.maxResults || 50_000);
        allEntries.push(...entries);
      }
    }

    // Filter by query
    let entries = this.filterEntries(allEntries, query);

    // Group by service
    const byService = new Map<string, LogEntry[]>();
    for (const e of entries) {
      const existing = byService.get(e.service) || [];
      existing.push(e);
      byService.set(e.service, existing);
    }

    // Group by level
    const byLevel = new Map<string, LogEntry[]>();
    for (const e of entries) {
      const existing = byLevel.get(e.level) || [];
      existing.push(e);
      byLevel.set(e.level, existing);
    }

    // Build timeline (bucketed by minute)
    const timelineBuckets = new Map<number, LogEntry[]>();
    for (const e of entries) {
      const bucket = Math.floor(e.timestamp.getTime() / 60_000) * 60_000;
      const existing = timelineBuckets.get(bucket) || [];
      existing.push(e);
      timelineBuckets.set(bucket, existing);
    }

    const timeline = [...timelineBuckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ts, bucketEntries]) => ({
        timestamp: new Date(ts),
        count: bucketEntries.length,
        entries: bucketEntries,
      }));

    // Compute error rate
    const errorCount = entries.filter(e => e.level === 'ERROR' || e.level === 'FATAL').length;
    const errorRate = entries.length > 0 ? errorCount / entries.length : 0;

    return {
      query,
      entries,
      totalMatches: entries.length,
      byService,
      byLevel,
      timeline,
      errorRate,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Tail logs in real-time, filtering by pattern.
   */
  tailLogs(
    filePath: string,
    pattern: string | RegExp,
    callback: (entry: LogEntry) => void,
  ): { stop: () => void } {
    const patternRe = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
    let lineNumber = 0;

    // Read existing lines first
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        lineNumber++;
        if (patternRe.test(line)) {
          const entry = this.parseLine(line, filePath, lineNumber);
          if (entry) callback(entry);
        }
      }
    }

    // Watch for new lines
    const watcher = watch(filePath, (eventType) => {
      if (eventType !== 'change') return;
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const newLines = lines.slice(lineNumber);
        for (let i = 0; i < newLines.length; i++) {
          const lineIdx = lineNumber + i + 1;
          if (patternRe.test(newLines[i])) {
            const entry = this.parseLine(newLines[i], filePath, lineIdx);
            if (entry) callback(entry);
          }
        }
        lineNumber = lines.length;
      } catch { /* file may be locked */ }
    });

    return {
      stop: () => watcher.close(),
    };
  }

  /**
   * Search logs with grep-like pattern matching.
   */
  grepLogs(logDirs: string[], pattern: string | RegExp): LogEntry[] {
    const results: LogEntry[] = [];
    const patternRe = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;

    for (const dir of logDirs) {
      if (!existsSync(dir)) continue;
      const logFiles = this.findLogFiles(dir);
      for (const file of logFiles) {
        try {
          const content = readFileSync(file, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (patternRe.test(lines[i])) {
              const entry = this.parseLine(lines[i], file, i + 1);
              if (entry) results.push(entry);
            }
          }
        } catch { /* skip unreadable files */ }
      }
    }

    return results;
  }

  private filterEntries(entries: LogEntry[], query: LogQuery): LogEntry[] {
    return entries.filter(e => {
      if (query.services && !query.services.includes(e.service)) return false;
      if (query.levels && !query.levels.includes(e.level)) return false;
      if (query.startTime && e.timestamp < query.startTime) return false;
      if (query.endTime && e.timestamp > query.endTime) return false;
      if (query.traceId && e.traceId !== query.traceId) return false;
      if (query.searchPattern) {
        const re = typeof query.searchPattern === 'string'
          ? new RegExp(query.searchPattern, 'i')
          : query.searchPattern;
        if (!re.test(e.message)) return false;
      }
      return true;
    });
  }

  private findLogFiles(dir: string, services?: string[]): string[] {
    const files: string[] = [];
    const logExtensions = new Set(['.log', '.txt', '.jsonl', '.ndjson', '.out']);

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...this.findLogFiles(fullPath, services));
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          const nameLower = entry.name.toLowerCase();
          if (logExtensions.has(ext) || nameLower.includes('log') || nameLower.includes('output')) {
            // Filter by service if specified
            if (services) {
              const matches = services.some(s => nameLower.includes(s.toLowerCase()));
              if (!matches) continue;
            }
            files.push(fullPath);
          }
        }
      }
    } catch { /* skip permission errors */ }

    return files;
  }

  private normalizeLevel(level: string): LogEntry['level'] {
    const upper = level.toUpperCase();
    if (upper.includes('FATAL') || upper.includes('CRITICAL') || upper.includes('CRIT')) return 'FATAL';
    if (upper.includes('ERROR') || upper.includes('ERR') || upper.includes('SEVERE')) return 'ERROR';
    if (upper.includes('WARN')) return 'WARN';
    if (upper.includes('DEBUG') || upper.includes('TRACE') || upper.includes('VERBOSE')) return 'DEBUG';
    if (upper.includes('INFO')) return 'INFO';
    return 'UNKNOWN';
  }

  private parseSyslogDate(syslogDate: string): Date {
    // Jan 15 10:30:00 — assume current year
    const currentYear = new Date().getFullYear();
    const parsed = new Date(`${syslogDate} ${currentYear}`);
    if (isNaN(parsed.getTime())) return new Date();
    return parsed;
  }
}

// ---------------------------------------------------------------------------
// Metric Anomaly Detector — GAP-101: z-score on time-series
// ---------------------------------------------------------------------------

export class MetricAnomalyDetector {
  /**
   * Compute z-scores for a time series and detect anomalies.
   */
  detectAnomalies(
    metricName: string,
    dataPoints: TimeSeriesPoint[],
    threshold = 2.5,
  ): AnomalyResult {
    if (dataPoints.length < 3) {
      return {
        metricName,
        dataPoints,
        mean: 0,
        stdDev: 0,
        zScores: [],
        anomalies: [],
        threshold,
        detected: false,
      };
    }

    const values = dataPoints.map(p => p.value);
    const mean = this.computeMean(values);
    const stdDev = this.computeStdDev(values, mean);

    const zScores: AnomalyResult['zScores'] = [];
    const anomalies: AnomalyResult['anomalies'] = [];

    for (let i = 0; i < values.length; i++) {
      const zScore = stdDev === 0 ? 0 : Math.abs((values[i] - mean) / stdDev);
      zScores.push({
        index: i,
        timestamp: dataPoints[i].timestamp,
        value: values[i],
        zScore: Math.round(zScore * 1000) / 1000,
      });

      if (zScore >= threshold) {
        let severity: AnomalyResult['anomalies'][0]['severity'] = 'low';
        if (zScore >= 5) severity = 'critical';
        else if (zScore >= 4) severity = 'high';
        else if (zScore >= 3) severity = 'medium';

        anomalies.push({
          index: i,
          timestamp: dataPoints[i].timestamp,
          value: values[i],
          zScore: Math.round(zScore * 1000) / 1000,
          severity,
        });
      }
    }

    return {
      metricName,
      dataPoints,
      mean: Math.round(mean * 1000) / 1000,
      stdDev: Math.round(stdDev * 1000) / 1000,
      zScores,
      anomalies,
      threshold,
      detected: anomalies.length > 0,
    };
  }

  /**
   * Detect anomalies across multiple metrics.
   */
  detectAcrossMetrics(
    metrics: Array<{ name: string; dataPoints: TimeSeriesPoint[] }>,
    threshold = 2.5,
  ): AnomalyResult[] {
    return metrics.map(m => this.detectAnomalies(m.name, m.dataPoints, threshold));
  }

  /**
   * Compute rolling z-scores (last N points).
   */
  rollingZScores(
    dataPoints: TimeSeriesPoint[],
    windowSize = 30,
  ): Array<{ timestamp: Date; value: number; zScore: number }> {
    const results: Array<{ timestamp: Date; value: number; zScore: number }> = [];

    for (let i = 0; i < dataPoints.length; i++) {
      const windowStart = Math.max(0, i - windowSize + 1);
      const windowValues = dataPoints.slice(windowStart, i + 1).map(p => p.value);
      const mean = this.computeMean(windowValues);
      const stdDev = this.computeStdDev(windowValues, mean);
      const zScore = stdDev === 0 ? 0 : Math.abs((dataPoints[i].value - mean) / stdDev);

      results.push({
        timestamp: dataPoints[i].timestamp,
        value: dataPoints[i].value,
        zScore: Math.round(zScore * 1000) / 1000,
      });
    }

    return results;
  }

  /**
   * Generate a summary of detected anomalies.
   */
  summarize(anomalies: AnomalyResult[]): string {
    const totalAnomalies = anomalies.reduce((sum, a) => sum + a.anomalies.length, 0);
    if (totalAnomalies === 0) return 'No anomalies detected across all metrics.';

    const lines = [`## Anomaly Summary — ${totalAnomalies} anomalies detected`, ''];

    for (const result of anomalies) {
      if (result.anomalies.length === 0) continue;
      lines.push(`### ${result.metricName}`);
      lines.push(`- Mean: ${result.mean}, StdDev: ${result.stdDev}, Threshold: ${result.threshold}σ`);
      lines.push('');

      for (const anomaly of result.anomalies) {
        const ts = anomaly.timestamp.toISOString();
        const dir = anomaly.value > result.mean ? '↑ spike' : '↓ dip';
        lines.push(`- **${anomaly.severity.toUpperCase()}** ${ts}: ${anomaly.value} (z=${anomaly.zScore}) ${dir}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private computeMean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private computeStdDev(values: number[], mean: number): number {
    if (values.length < 2) return 0;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }
}

// ---------------------------------------------------------------------------
// Incident Timeline Builder — GAP-101: correlate logs + deploys + alerts
// ---------------------------------------------------------------------------

export class IncidentTimelineBuilder {
  /**
   * Build a correlated incident timeline from logs, deploys, and alerts.
   */
  build(
    title: string,
    logEntries: LogEntry[],
    deploys: DeployEvent[],
    alerts: AlertEvent[],
    anomalies: AnomalyResult[],
  ): IncidentTimeline {
    const events: IncidentEvent[] = [];

    // Add deploy events
    for (const deploy of deploys) {
      events.push({
        type: 'deploy',
        timestamp: deploy.timestamp,
        source: deploy.service,
        detail: `Deploy ${deploy.version} (${deploy.commit}) by ${deploy.author}: ${deploy.status}`,
        data: deploy as unknown as Record<string, unknown>,
      });
    }

    // Add alert events
    for (const alert of alerts) {
      events.push({
        type: 'alert',
        timestamp: alert.timestamp,
        source: alert.service,
        detail: `[${alert.severity.toUpperCase()}] ${alert.title}: ${alert.description}`,
        data: alert as unknown as Record<string, unknown>,
      });
    }

    // Add log error events
    for (const entry of logEntries.filter(e => e.level === 'ERROR' || e.level === 'FATAL')) {
      events.push({
        type: 'log-error',
        timestamp: entry.timestamp,
        source: entry.service,
        detail: entry.message,
        data: entry as unknown as Record<string, unknown>,
      });
    }

    // Add log warn events (significant ones)
    const significantWarns = logEntries
      .filter(e => e.level === 'WARN')
      .slice(0, 50); // Limit to avoid overwhelming
    for (const entry of significantWarns) {
      events.push({
        type: 'log-warn',
        timestamp: entry.timestamp,
        source: entry.service,
        detail: entry.message,
        data: entry as unknown as Record<string, unknown>,
      });
    }

    // Add metric anomalies
    for (const anomaly of anomalies) {
      for (const point of anomaly.anomalies) {
        events.push({
          type: 'metric-anomaly',
          timestamp: point.timestamp,
          source: anomaly.metricName,
          detail: `${anomaly.metricName}: ${point.value} (z=${point.zScore}, ${point.severity})`,
          data: point as unknown as Record<string, unknown>,
        });
      }
    }

    // Sort by timestamp
    events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Determine time range
    const startTime = events.length > 0
      ? events[0].timestamp
      : new Date();
    const endTime = events.length > 0
      ? events[events.length - 1].timestamp
      : new Date();

    // Determine services involved
    const services = [...new Set(events.map(e => e.source))];

    // Determine severity
    const hasCriticalAlert = alerts.some(a => a.severity === 'critical');
    const hasFatalLog = logEntries.some(e => e.level === 'FATAL');
    const hasHighAnomaly = anomalies.some(a => a.anomalies.some(p => p.severity === 'critical' || p.severity === 'high'));
    let severity: IncidentTimeline['severity'] = 'low';
    if (hasCriticalAlert || hasFatalLog) severity = 'critical';
    else if (hasHighAnomaly) severity = 'high';
    else if (events.length > 20) severity = 'medium';

    // Check for correlations: errors happening right after deploys
    const correlated = this.detectCorrelations(events);

    const timeline: IncidentTimeline = {
      id: `incident-${randomUUID().slice(0, 8)}`,
      title,
      events,
      startTime,
      endTime,
      services,
      severity,
      rootCauseHypotheses: [],
      correlated,
    };

    return timeline;
  }

  /**
   * Detect correlations between events.
   * Returns true if error events cluster after deploy events.
   */
  private detectCorrelations(events: IncidentEvent[]): boolean {
    const deploys = events.filter(e => e.type === 'deploy' && (e.data as { status?: string }).status !== 'failed');
    const errors = events.filter(e => e.type === 'log-error' || e.type === 'alert');

    for (const deploy of deploys) {
      const deployTime = deploy.timestamp.getTime();
      // Count errors within 15 minutes after deploy
      const postDeployErrors = errors.filter(e => {
        const diff = e.timestamp.getTime() - deployTime;
        return diff > 0 && diff < 15 * 60_000;
      });

      if (postDeployErrors.length >= 3) return true;
    }

    return false;
  }

  /**
   * Export the timeline as a Markdown report.
   */
  exportMarkdown(timeline: IncidentTimeline): string {
    const lines: string[] = [
      `# Incident Timeline: ${timeline.title}`,
      '',
      `**ID**: ${timeline.id}`,
      `**Severity**: ${timeline.severity.toUpperCase()}`,
      `**Time Range**: ${timeline.startTime.toISOString()} — ${timeline.endTime.toISOString()}`,
      `**Services**: ${timeline.services.join(', ')}`,
      `**Total Events**: ${timeline.events.length}`,
      `**Correlated with Deploy**: ${timeline.correlated ? '⚠️ Yes' : 'No'}`,
      '',
      '---',
      '',
      '## Timeline',
      '',
      '| Time | Type | Source | Detail |',
      '|------|------|--------|--------|',
    ];

    for (const event of timeline.events) {
      const time = event.timestamp.toISOString().split('T')[1]?.replace('Z', '') || event.timestamp.toISOString();
      const typeIcon: Record<string, string> = {
        'deploy': '🚀',
        'alert': '🔔',
        'log-error': '❌',
        'log-warn': '⚠️',
        'metric-anomaly': '📈',
        'manual': '👤',
      };
      const icon = typeIcon[event.type] || '•';
      lines.push(`| ${time} | ${icon} ${event.type} | ${event.source} | ${event.detail.slice(0, 100)} |`);
    }

    if (timeline.rootCauseHypotheses.length > 0) {
      lines.push('');
      lines.push('## Root Cause Hypotheses');
      for (const hypothesis of timeline.rootCauseHypotheses) {
        lines.push('');
        lines.push(`### ${hypothesis.hypothesis} (confidence: ${(hypothesis.confidence * 100).toFixed(0)}%)`);
        lines.push('');
        if (hypothesis.supportingEvidence.length > 0) {
          lines.push('**Supporting Evidence:**');
          for (const ev of hypothesis.supportingEvidence) lines.push(`- ${ev}`);
        }
        if (hypothesis.contradictingEvidence.length > 0) {
          lines.push('**Contradicting Evidence:**');
          for (const ev of hypothesis.contradictingEvidence) lines.push(`- ${ev}`);
        }
        if (hypothesis.suggestedActions.length > 0) {
          lines.push('**Suggested Actions:**');
          for (const act of hypothesis.suggestedActions) lines.push(`- ${act}`);
        }
      }
    }

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// AI-Driven Root Cause Hypothesis Generator — GAP-101
// ---------------------------------------------------------------------------

export class RootCauseAnalyzer {
  private readonly KNOWN_PATTERNS: Array<{
    pattern: RegExp;
    hypothesis: string;
    actions: string[];
  }> = [
    {
      pattern: /out\s+of\s+memory|OOM|heap\s+space|allocation\s+fail/i,
      hypothesis: 'Memory exhaustion — application ran out of heap space',
      actions: [
        'Check memory limits and heap dumps',
        'Review recent code changes for memory leaks',
        'Increase container/VM memory allocation',
        'Enable heap profiling',
      ],
    },
    {
      pattern: /connection\s+(refused|timeout|reset)|ECONNREFUSED|ETIMEDOUT/i,
      hypothesis: 'Network connectivity issue — downstream service unreachable',
      actions: [
        'Verify downstream service health',
        'Check network policies and firewall rules',
        'Review service discovery/DNS configuration',
        'Check for TLS certificate expiration',
      ],
    },
    {
      pattern: /rate\s+limit|too\s+many\s+requests|429|throttl/i,
      hypothesis: 'Rate limiting triggered — traffic exceeded configured thresholds',
      actions: [
        'Review rate limit configuration',
        'Check for traffic spikes or abuse patterns',
        'Consider increasing rate limits or adding capacity',
        'Implement backoff/retry on client side',
      ],
    },
    {
      pattern: /timeout|deadline\s+exceed(ed)?|context\s+cancel(l)?ed/i,
      hypothesis: 'Operation timeout — request exceeded deadline',
      actions: [
        'Identify which operation is timing out',
        'Check downstream latency metrics',
        'Review timeout configuration values',
        'Consider adding circuit breakers',
      ],
    },
    {
      pattern: /null\s+pointer|null\s+reference|undefined|nil\s+pointer|NPE/i,
      hypothesis: 'Null reference error — unexpected nil/undefined value',
      actions: [
        'Locate the source of the null value in code',
        'Add null checks or optional chaining',
        'Review recent data model changes',
      ],
    },
    {
      pattern: /disk\s+(full|quota|space)|ENOSPC|no\s+space/i,
      hypothesis: 'Disk space exhaustion — volume or partition full',
      actions: [
        'Check disk usage on affected nodes',
        'Clean up old logs, artifacts, or temporary files',
        'Increase disk allocation or enable log rotation',
      ],
    },
    {
      pattern: /deadlock|lock\s+wait|timeout.*lock/i,
      hypothesis: 'Deadlock or lock contention — concurrent operations blocked',
      actions: [
        'Check for long-running transactions',
        'Review locking patterns in recent code changes',
        'Consider using optimistic locking',
      ],
    },
    {
      pattern: /deploy|rollout|release|version.*chang/i,
      hypothesis: 'Recent deployment may have introduced a regression',
      actions: [
        'Compare diff between current and previous version',
        'Check if a rollback resolves the issue',
        'Review deployment logs for errors',
        'Verify feature flag configuration',
      ],
    },
    {
      pattern: /config(uration)?.*chang|env.*var/i,
      hypothesis: 'Configuration change may have triggered the incident',
      actions: [
        'Audit recent configuration changes',
        'Check if environment variables differ between environments',
        'Verify config validation is working correctly',
      ],
    },
    {
      pattern: /certificate|cert|TLS|SSL|handshake/i,
      hypothesis: 'TLS/Certificate issue — secure connection failed',
      actions: [
        'Check certificate expiration dates',
        'Verify CA chain is complete',
        'Ensure correct certificate/key pair is deployed',
      ],
    },
  ];

  /**
   * Generate root cause hypotheses from event data.
   */
  analyze(timeline: IncidentTimeline): RootCauseHypothesis[] {
    const hypotheses: RootCauseHypothesis[] = [];

    // Extract all error messages
    const errorMessages = timeline.events
      .filter(e => e.type === 'log-error' || e.type === 'alert')
      .map(e => e.detail)
      .join('\n');

    // Match against known patterns
    for (const known of this.KNOWN_PATTERNS) {
      if (known.pattern.test(errorMessages)) {
        const supportingEvidence: string[] = [];
        const relatedEventIndices: number[] = [];

        // Find specific events that match
        for (let i = 0; i < timeline.events.length; i++) {
          const event = timeline.events[i];
          if (event.type === 'log-error' && known.pattern.test(event.detail)) {
            supportingEvidence.push(
              `${event.timestamp.toISOString()}: ${event.source} — ${event.detail.slice(0, 120)}`,
            );
            relatedEventIndices.push(i);
          }
        }

        hypotheses.push({
          id: `hyp-${randomUUID().slice(0, 8)}`,
          hypothesis: known.hypothesis,
          confidence: Math.min(supportingEvidence.length * 0.15 + 0.3, 0.95),
          supportingEvidence,
          contradictingEvidence: [],
          suggestedActions: known.actions,
          relatedEvents: relatedEventIndices,
        });
      }
    }

    // If deploy was recent and errors followed, add deploy regression hypothesis
    if (timeline.correlated && !hypotheses.some(h => h.hypothesis.includes('deployment'))) {
      const recentDeploy = timeline.events
        .filter(e => e.type === 'deploy' && (e.data as { status?: string }).status !== 'failed')
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];

      if (recentDeploy) {
        hypotheses.push({
          id: `hyp-${randomUUID().slice(0, 8)}`,
          hypothesis: `Recent deployment (${recentDeploy.detail.slice(0, 80)}) may have introduced a regression`,
          confidence: 0.5,
          supportingEvidence: [
            `Deploy at ${recentDeploy.timestamp.toISOString()} was followed by ${timeline.events.filter(e => e.timestamp > recentDeploy.timestamp && (e.type === 'log-error' || e.type === 'alert')).length} error events`,
          ],
          contradictingEvidence: [],
          suggestedActions: [
            'Compare diff between deployed and previous versions',
            'Attempt rollback to verify if issue resolves',
            'Review feature flags changed in this deploy',
          ],
          relatedEvents: [timeline.events.indexOf(recentDeploy)],
        });
      }
    }

    // Sort by confidence descending
    hypotheses.sort((a, b) => b.confidence - a.confidence);

    return hypotheses;
  }

  /**
   * Generate a natural-language investigation summary.
   */
  summarize(
    timeline: IncidentTimeline,
    anomalies: AnomalyResult[],
    logSummary: AggregatedLogs | null,
  ): InvestigationReport {
    const hypotheses = this.analyze(timeline);
    timeline.rootCauseHypotheses = hypotheses;

    const anomalyCount = anomalies.reduce((s, a) => s + a.anomalies.length, 0);

    const summaryLines: string[] = [
      `Investigation of incident "${timeline.title}" identified ${timeline.events.length} events`,
      `across ${timeline.services.length} service(s) over ${
        Math.round((timeline.endTime.getTime() - timeline.startTime.getTime()) / 60_000)
      } minutes.`,
    ];

    if (hypotheses.length > 0) {
      summaryLines.push(
        `The top hypothesis (${(hypotheses[0].confidence * 100).toFixed(0)}% confidence) is: ${hypotheses[0].hypothesis}`,
      );
    }

    if (anomalyCount > 0) {
      summaryLines.push(`${anomalyCount} metric anomalies were detected during this period.`);
    }

    if (logSummary) {
      const errorRate = (logSummary.errorRate * 100).toFixed(1);
      summaryLines.push(`Overall error rate during the incident: ${errorRate}%`);
    }

    const recommendations = [
      ...new Set(hypotheses.flatMap(h => h.suggestedActions)),
    ];

    if (timeline.correlated && !recommendations.some(r => r.includes('rollback'))) {
      recommendations.push('Consider rolling back the most recent deployment if available');
    }
    if (!recommendations.some(r => r.includes('alert'))) {
      recommendations.push('Review and improve alerting thresholds for the affected services');
    }

    return {
      id: `inv-${randomUUID().slice(0, 8)}`,
      generatedAt: new Date(),
      timeline,
      anomalies,
      aggregatedLogs: logSummary,
      summary: summaryLines.join(' '),
      recommendations,
    };
  }
}

// ---------------------------------------------------------------------------
// Operational Investigator — main orchestrator (GAP-101)
// ---------------------------------------------------------------------------

export interface InvestigationOptions {
  logDirectories: string[];
  title: string;
  services?: string[];
  timeRange?: { start: Date; end: Date };
  errorPattern?: string;
  deployHistory?: DeployEvent[];
  alertHistory?: AlertEvent[];
  metrics?: Array<{ name: string; dataPoints: TimeSeriesPoint[] }>;
  anomalyThreshold?: number;
}

export class OperationalInvestigator {
  private logAggregator: LogAggregator;
  private anomalyDetector: MetricAnomalyDetector;
  private timelineBuilder: IncidentTimelineBuilder;
  private rootCauseAnalyzer: RootCauseAnalyzer;

  constructor() {
    this.logAggregator = new LogAggregator();
    this.anomalyDetector = new MetricAnomalyDetector();
    this.timelineBuilder = new IncidentTimelineBuilder();
    this.rootCauseAnalyzer = new RootCauseAnalyzer();
  }

  /**
   * Run a full investigation: gather logs, detect anomalies, build timeline, analyze root cause.
   */
  async investigate(options: InvestigationOptions): Promise<InvestigationReport> {
    // Phase 1: Aggregate logs
    const logQuery: LogQuery = {
      services: options.services,
      levels: ['ERROR', 'FATAL', 'WARN'],
      startTime: options.timeRange?.start,
      endTime: options.timeRange?.end,
      searchPattern: options.errorPattern,
    };

    const logSummary = await this.logAggregator.aggregate(
      options.logDirectories,
      logQuery,
    );

    // Phase 2: Detect anomalies
    const anomalies = options.metrics
      ? this.anomalyDetector.detectAcrossMetrics(options.metrics, options.anomalyThreshold ?? 2.5)
      : [];

    // Phase 3: Build incident timeline
    const timeline = this.timelineBuilder.build(
      options.title,
      logSummary.entries,
      options.deployHistory || [],
      options.alertHistory || [],
      anomalies,
    );

    // Phase 4: Generate root cause hypotheses
    const report = this.rootCauseAnalyzer.summarize(timeline, anomalies, logSummary);

    return report;
  }

  /**
   * Export the investigation report to Markdown.
   */
  exportReport(report: InvestigationReport, outputPath: string): string {
    const lines: string[] = [
      `# Operational Investigation Report`,
      '',
      `**ID**: ${report.id}`,
      `**Generated**: ${report.generatedAt.toISOString()}`,
      '',
      '---',
      '',
      '## Summary',
      '',
      report.summary,
      '',
      '---',
      '',
      this.timelineBuilder.exportMarkdown(report.timeline),
      '',
      '---',
      '',
      this.anomalyDetector.summarize(report.anomalies),
      '',
      '---',
      '',
      '## Recommendations',
      '',
      ...report.recommendations.map((r, i) => `${i + 1}. ${r}`),
      '',
    ];

    const content = lines.join('\n');

    if (outputPath) {
      const dir = dirname(outputPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(outputPath, content);
    }

    return content;
  }

  /**
   * Quick investigation: just search logs for a pattern.
   */
  quickSearch(logDirectories: string[], pattern: string): LogEntry[] {
    return this.logAggregator.grepLogs(logDirectories, pattern);
  }

  /**
   * Real-time tail logs from a file.
   */
  tailLog(
    filePath: string,
    pattern: string,
    onMatch: (entry: LogEntry) => void,
  ): { stop: () => void } {
    return this.logAggregator.tailLogs(filePath, pattern, onMatch);
  }
}

// ---------------------------------------------------------------------------
// Convenience exports
// ---------------------------------------------------------------------------

export function quickGrepLogs(dirs: string[], pattern: string): LogEntry[] {
  return new LogAggregator().grepLogs(dirs, pattern);
}

export function quickDetectAnomalies(
  metricName: string,
  values: number[],
  threshold?: number,
): AnomalyResult {
  const now = Date.now();
  const points: TimeSeriesPoint[] = values.map((v, i) => ({
    timestamp: new Date(now - (values.length - i) * 60_000),
    value: v,
  }));
  return new MetricAnomalyDetector().detectAnomalies(metricName, points, threshold);
}

export function quickAnalyzeRootCause(timeline: IncidentTimeline): RootCauseHypothesis[] {
  return new RootCauseAnalyzer().analyze(timeline);
}
