import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as dgram from 'node:dgram';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface MonitoringConfig {
  /** Datadog DogStatsD host */
  dogStatsDHost?: string;
  /** Datadog DogStatsD port (default 8125) */
  dogStatsDPort?: number;
  /** Datadog API key for event submission */
  datadogApiKey?: string;
  /** Datadog site (e.g., datadoghq.com) */
  datadogSite?: string;
  /** New Relic API key (for Event API) */
  newRelicApiKey?: string;
  /** New Relic account ID */
  newRelicAccountId?: number;
  /** New Relic region (US or EU) */
  newRelicRegion?: 'US' | 'EU';
  /** Alert webhook secret for verifying incoming payloads */
  alertWebhookSecret?: string;
  /** Whether the in-IDE overlay is enabled */
  overlayEnabled?: boolean;
}

export interface DogStatsDMetric {
  name: string;
  value: number;
  type: 'gauge' | 'count' | 'histogram' | 'set' | 'distribution';
  tags?: string[];
  sampleRate?: number;
  timestamp?: number;
}

export interface DatadogEvent {
  title: string;
  text: string;
  alertType?: 'info' | 'warning' | 'error' | 'success';
  priority?: 'normal' | 'low';
  tags?: string[];
  host?: string;
  aggregationKey?: string;
  sourceTypeName?: string;
}

export interface NewRelicEvent {
  eventType: string;
  timestamp?: number;
  attributes: Record<string, string | number | boolean>;
}

export interface AlertPayload {
  id: string;
  source: 'pagerduty' | 'opsgenie' | 'victorops' | 'datadog' | 'grafana';
  title: string;
  description: string;
  severity: 'critical' | 'error' | 'warning' | 'info';
  status: 'triggered' | 'acknowledged' | 'resolved';
  service?: string;
  environment?: string;
  link?: string;
  timestamp: number;
  rawPayload: unknown;
}

export interface AlertOverlayState {
  alerts: AlertPayload[];
  dismissed: Set<string>;
  isVisible: boolean;
  position: 'top-right' | 'bottom-right' | 'top-left' | 'bottom-left';
  maxAlerts: number;
}

// ─── DogStatsD Metrics Exporter ───────────────────────────────────────────

export class DogStatsDExporter {
  private client: dgram.Socket;
  private host: string;
  private port: number;
  private queue: Buffer[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private defaultTags: string[];

  constructor(
    host: string = '127.0.0.1',
    port: number = 8125,
    defaultTags: string[] = [],
  ) {
    this.host = host;
    this.port = port;
    this.defaultTags = defaultTags;
    this.client = dgram.createSocket('udp4');
  }

  /** Send a gauge metric. */
  gauge(name: string, value: number, tags?: string[]): void {
    this.send({ name, value, type: 'gauge', tags });
  }

  /** Send a count metric. */
  count(name: string, value: number, tags?: string[]): void {
    this.send({ name, value, type: 'count', tags });
  }

  /** Send a histogram metric. */
  histogram(name: string, value: number, tags?: string[]): void {
    this.send({ name, value, type: 'histogram', tags });
  }

  /** Send a set metric. */
  set(name: string, value: string, tags?: string[]): void {
    this.send({ name, value: value.length, type: 'set', tags });
  }

  /** Send a distribution metric. */
  distribution(name: string, value: number, tags?: string[]): void {
    this.send({ name, value, type: 'distribution', tags });
  }

  /** Send a timing metric (in ms). */
  timing(name: string, durationMs: number, tags?: string[]): void {
    this.send({ name, value: durationMs, type: 'histogram', tags: [...(tags || []), 'unit:ms'] });
  }

  /** Increment a counter by 1. */
  increment(name: string, tags?: string[]): void {
    this.count(name, 1, tags);
  }

  /** Decrement a counter by 1. */
  decrement(name: string, tags?: string[]): void {
    this.count(name, -1, tags);
  }

  /** Record a function execution time. */
  async time<T>(name: string, fn: () => Promise<T>, tags?: string[]): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.timing(name, Math.round(performance.now() - start), tags);
    }
  }

  /** Flush all queued metrics. */
  flush(): void {
    for (const buf of this.queue) {
      this.client.send(buf, 0, buf.length, this.port, this.host, (err) => {
        if (err) { /* UDP errors are expected sometimes */ }
      });
    }
    this.queue = [];
  }

  /** Start auto-flushing at an interval (ms). */
  startAutoFlush(intervalMs: number = 10_000): void {
    this.stopAutoFlush();
    this.flushInterval = setInterval(() => this.flush(), intervalMs);
  }

  /** Stop auto-flushing. */
  stopAutoFlush(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  /** Close the UDP socket. */
  close(): void {
    this.stopAutoFlush();
    this.flush();
    this.client.close();
  }

  private send(metric: DogStatsDMetric): void {
    const allTags = [...this.defaultTags, ...(metric.tags || [])];
    const tagStr = allTags.length > 0 ? '|#' + allTags.join(',') : '';
    const ts = metric.timestamp ? `|T${Math.floor(metric.timestamp)}` : '';
    const sampleRate = metric.sampleRate && metric.sampleRate < 1 ? `|@${metric.sampleRate}` : '';

    const typeChar: Record<string, string> = {
      gauge: 'g', count: 'c', histogram: 'h', set: 's', distribution: 'd',
    };

    const line = `${metric.name}:${metric.value}|${typeChar[metric.type] || 'g'}${sampleRate}${ts}${tagStr}`;
    this.queue.push(Buffer.from(line));
  }
}

// ─── New Relic Event API Client ───────────────────────────────────────────

export class NewRelicEventClient {
  private apiKey: string;
  private accountId: number;
  private baseUrl: string;

  constructor(apiKey: string, accountId: number, region: 'US' | 'EU' = 'US') {
    this.apiKey = apiKey;
    this.accountId = accountId;
    this.baseUrl = region === 'EU'
      ? 'https://insights-collector.eu01.nr-data.net/v1/accounts'
      : 'https://insights-collector.newrelic.com/v1/accounts';
  }

  /** Send a single custom event to New Relic. */
  async sendEvent(event: NewRelicEvent): Promise<boolean> {
    const payload = [{
      eventType: event.eventType,
      timestamp: event.timestamp || Date.now(),
      ...event.attributes,
    }];

    const resp = await fetch(
      `${this.baseUrl}/${this.accountId}/events`,
      {
        method: 'POST',
        headers: {
          'Api-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );

    return resp.ok;
  }

  /** Send a batch of events. */
  async sendEvents(events: NewRelicEvent[]): Promise<{ sent: number; failed: number }> {
    const payload = events.map(e => ({
      eventType: e.eventType,
      timestamp: e.timestamp || Date.now(),
      ...e.attributes,
    }));

    const resp = await fetch(
      `${this.baseUrl}/${this.accountId}/events`,
      {
        method: 'POST',
        headers: {
          'Api-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );

    return resp.ok
      ? { sent: events.length, failed: 0 }
      : { sent: 0, failed: events.length };
  }

  /** Record a deployment event. */
  async recordDeployment(params: {
    appName: string;
    version: string;
    revision?: string;
    changelog?: string;
    user?: string;
    environment?: string;
  }): Promise<boolean> {
    return this.sendEvent({
      eventType: 'Deployment',
      attributes: {
        appName: params.appName,
        version: params.version,
        revision: params.revision || '',
        changelog: params.changelog || '',
        user: params.user || '',
        environment: params.environment || 'production',
      },
    });
  }

  /** Record an AI model usage event. */
  async recordModelUsage(params: {
    model: string;
    provider: string;
    tokensIn: number;
    tokensOut: number;
    durationMs: number;
    success: boolean;
  }): Promise<boolean> {
    return this.sendEvent({
      eventType: 'AIModelUsage',
      attributes: {
        model: params.model,
        provider: params.provider,
        tokensIn: params.tokensIn,
        tokensOut: params.tokensOut,
        totalTokens: params.tokensIn + params.tokensOut,
        durationMs: params.durationMs,
        success: params.success,
      },
    });
  }
}

// ─── Alert Webhook Receiver (PagerDuty / Opsgenie) ────────────────────────

export class AlertWebhookReceiver extends EventEmitter {
  private secret?: string;

  constructor(secret?: string) {
    super();
    this.secret = secret;
  }

  /** Parse and validate an incoming PagerDuty webhook payload. */
  parsePagerDuty(payload: Record<string, unknown>): AlertPayload | null {
    const messages = (payload.messages as unknown[]) || [];
    if (messages.length === 0) return null;

    const msg = messages[0] as Record<string, unknown>;
    const incident = (msg.incident || payload.incident || {}) as Record<string, unknown>;

    if (!incident.id) return null;

    return {
      id: 'pd-' + (incident.id as string),
      source: 'pagerduty',
      title: (incident.title as string) || 'Unknown incident',
      description: (incident.description as string) || '',
      severity: this.mapPagerDutySeverity(incident.severity as string, incident.status as string),
      status: this.mapPagerDutyStatus(incident.status as string),
      service: (incident.service as Record<string, unknown>)?.summary as string,
      link: (incident.html_url as string) || '',
      timestamp: new Date((incident.created_at as string) || Date.now()).getTime(),
      rawPayload: payload,
    };
  }

  /** Parse and validate an incoming Opsgenie webhook payload. */
  parseOpsgenie(payload: Record<string, unknown>): AlertPayload | null {
    const alert = (payload.alert || {}) as Record<string, unknown>;
    if (!alert.alertId) return null;

    return {
      id: 'og-' + (alert.alertId as string),
      source: 'opsgenie',
      title: (alert.message as string) || 'Unknown alert',
      description: (alert.description as string) || '',
      severity: this.mapOpsgenieSeverity(alert.priority as string),
      status: this.mapOpsgenieStatus((payload.action as string) || 'Create'),
      service: (alert.tags as string[])?.join(', ') || '',
      link: (alert.tinyId as string) ? `https://app.opsgenie.com/alert/detail/${alert.tinyId}` : '',
      timestamp: new Date((alert.createdAt as string) || Date.now()).getTime(),
      rawPayload: payload,
    };
  }

  /** Parse a generic Datadog monitor webhook. */
  parseDatadogMonitor(payload: Record<string, unknown>): AlertPayload | null {
    const id = payload.id as string;
    if (!id) return null;

    return {
      id: 'dd-' + id,
      source: 'datadog',
      title: (payload.title as string) || (payload.alert_title as string) || 'Datadog alert',
      description: (payload.alert_transition as string) || (payload.body as string) || '',
      severity: this.mapDatadogSeverity(payload.alert_type as string),
      status: this.mapDatadogStatus(payload.alert_transition as string),
      service: (payload.tags as string) || '',
      link: (payload.link as string) || '',
      timestamp: (payload.date as number) || Date.now(),
      rawPayload: payload,
    };
  }

  /** Generic parse — detects source and delegates. */
  parseGeneric(payload: Record<string, unknown>): AlertPayload | null {
    // PagerDuty has a "messages" array
    if (payload.messages) return this.parsePagerDuty(payload);
    // Opsgenie has an "alert" object with "alertId"
    if ((payload.alert as Record<string, unknown>)?.alertId) return this.parseOpsgenie(payload);
    // Datadog has "alert_transition" or "alert_type"
    if (payload.alert_transition || payload.alert_type) return this.parseDatadogMonitor(payload);

    // Fallback: unknown source, best-effort
    return {
      id: 'unknown-' + randomUUID().slice(0, 8),
      source: 'datadog',
      title: (payload.title as string) || (payload.name as string) || 'Unknown alert',
      description: (payload.message as string) || (payload.description as string) || '',
      severity: 'warning',
      status: 'triggered',
      timestamp: Date.now(),
      rawPayload: payload,
    };
  }

  /** Process incoming alert and emit if valid. */
  processAlert(parsed: AlertPayload | null): AlertPayload | null {
    if (!parsed) return null;
    this.emit('alert', parsed);
    return parsed;
  }

  // ─── Severity / Status mapping helpers ──────────────────────────────────

  private mapPagerDutySeverity(severity?: string, status?: string): AlertPayload['severity'] {
    if (status === 'resolved') return 'info';
    switch (severity) {
      case 'critical': return 'critical';
      case 'error': return 'error';
      case 'warning': return 'warning';
      default: return 'info';
    }
  }

  private mapPagerDutyStatus(status?: string): AlertPayload['status'] {
    switch (status) {
      case 'triggered': return 'triggered';
      case 'acknowledged': return 'acknowledged';
      case 'resolved': return 'resolved';
      default: return 'triggered';
    }
  }

  private mapOpsgenieSeverity(priority?: string): AlertPayload['severity'] {
    switch (priority) {
      case 'P1': return 'critical';
      case 'P2': return 'error';
      case 'P3': return 'warning';
      case 'P4':
      case 'P5': return 'info';
      default: return 'warning';
    }
  }

  private mapOpsgenieStatus(action: string): AlertPayload['status'] {
    if (action.toLowerCase().includes('close') || action.toLowerCase().includes('resolve')) return 'resolved';
    if (action.toLowerCase().includes('acknowledge')) return 'acknowledged';
    return 'triggered';
  }

  private mapDatadogSeverity(alertType?: string): AlertPayload['severity'] {
    switch (alertType) {
      case 'error': return 'error';
      case 'warning': return 'warning';
      case 'success':
      case 'info': return 'info';
      default: return 'warning';
    }
  }

  private mapDatadogStatus(transition?: string): AlertPayload['status'] {
    switch (transition) {
      case 'Triggered': return 'triggered';
      case 'Recovered':
      case 'Resolved': return 'resolved';
      default: return 'triggered';
    }
  }
}

// ─── In-IDE Alert Overlay ─────────────────────────────────────────────────

export class AlertOverlay {
  state: AlertOverlayState;
  private onStateChange?: (state: AlertOverlayState) => void;

  constructor(
    position: AlertOverlayState['position'] = 'top-right',
    maxAlerts: number = 5,
    onStateChange?: (state: AlertOverlayState) => void,
  ) {
    this.state = {
      alerts: [],
      dismissed: new Set(),
      isVisible: true,
      position,
      maxAlerts,
    };
    this.onStateChange = onStateChange;
  }

  /** Push a new alert into the overlay. */
  pushAlert(alert: AlertPayload): void {
    // Avoid duplicates
    if (this.state.alerts.some(a => a.id === alert.id)) return;

    this.state.alerts.unshift(alert);

    // Trim to max
    if (this.state.alerts.length > this.state.maxAlerts) {
      this.state.alerts = this.state.alerts.slice(0, this.state.maxAlerts);
    }

    this.notifyStateChange();
  }

  /** Update an existing alert (e.g., from triggered → resolved). */
  updateAlert(id: string, update: Partial<Pick<AlertPayload, 'status' | 'severity' | 'description'>>): boolean {
    const alert = this.state.alerts.find(a => a.id === id);
    if (!alert) return false;
    if (update.status) alert.status = update.status;
    if (update.severity) alert.severity = update.severity;
    if (update.description !== undefined) alert.description = update.description;
    this.notifyStateChange();
    return true;
  }

  /** Dismiss an alert (hides it from overlay). */
  dismissAlert(id: string): void {
    this.state.dismissed.add(id);
    this.state.alerts = this.state.alerts.filter(a => a.id !== id);
    this.notifyStateChange();
  }

  /** Clear all alerts. */
  clearAll(): void {
    this.state.alerts.forEach(a => this.state.dismissed.add(a.id));
    this.state.alerts = [];
    this.notifyStateChange();
  }

  /** Toggle overlay visibility. */
  toggle(): boolean {
    this.state.isVisible = !this.state.isVisible;
    this.notifyStateChange();
    return this.state.isVisible;
  }

  /** Get active (non-dismissed) alerts. */
  getActiveAlerts(): AlertPayload[] {
    return this.state.alerts.filter(a => !this.state.dismissed.has(a.id));
  }

  /** Get alert count by severity. */
  getAlertCounts(): Record<string, number> {
    const counts: Record<string, number> = { critical: 0, error: 0, warning: 0, info: 0, total: 0 };
    for (const alert of this.getActiveAlerts()) {
      counts[alert.severity]++;
      counts.total++;
    }
    return counts;
  }

  /** Render the alert overlay as a formatted string (for TUI display). */
  render(): string {
    if (!this.state.isVisible) return '';
    const active = this.getActiveAlerts();
    if (active.length === 0) return '';

    const lines = ['┌─ Production Alerts ─────────────────────────────┐'];
    for (const alert of active.slice(0, 5)) {
      const severityIcon: Record<string, string> = {
        critical: '🔴', error: '🟠', warning: '🟡', info: '🔵',
      };
      const statusIcon: Record<string, string> = {
        triggered: '●', acknowledged: '◐', resolved: '○',
      };
      const icon = severityIcon[alert.severity] || '⚪';
      const status = statusIcon[alert.status] || '?';
      const title = alert.title.length > 45 ? alert.title.slice(0, 42) + '...' : alert.title;
      lines.push(`│ ${icon} ${status} ${title.padEnd(45)}│`);
    }
    lines.push('└────────────────────────────────────────────────┘');
    return lines.join('\n');
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange({ ...this.state, dismissed: new Set(this.state.dismissed) });
    }
  }
}

// ─── MonitoringIntegration (Facade) ────────────────────────────────────────

export class MonitoringIntegration {
  statsD: DogStatsDExporter;
  newRelic?: NewRelicEventClient;
  alertReceiver: AlertWebhookReceiver;
  overlay: AlertOverlay;
  private config: MonitoringConfig;

  constructor(config: MonitoringConfig = {}) {
    this.config = config;

    this.statsD = new DogStatsDExporter(
      config.dogStatsDHost || '127.0.0.1',
      config.dogStatsDPort || 8125,
      ['source:cobra-commander'],
    );

    if (config.newRelicApiKey && config.newRelicAccountId) {
      this.newRelic = new NewRelicEventClient(
        config.newRelicApiKey,
        config.newRelicAccountId,
        config.newRelicRegion || 'US',
      );
    }

    this.alertReceiver = new AlertWebhookReceiver(config.alertWebhookSecret);
    this.overlay = new AlertOverlay('top-right', 5);

    // Wire alert receiver → overlay
    this.alertReceiver.on('alert', (alert: AlertPayload) => {
      this.overlay.pushAlert(alert);
      // Auto-resolve after 10s for testing (in production, resolution comes from webhook)
    });

    if (config.overlayEnabled !== false) {
      this.statsD.startAutoFlush(10_000);
    }
  }

  /** Track a request metric. */
  trackRequest(params: {
    endpoint: string;
    method: string;
    statusCode: number;
    durationMs: number;
    success: boolean;
  }): void {
    const tags = [
      `endpoint:${params.endpoint}`,
      `method:${params.method}`,
      `status:${params.statusCode}`,
      `success:${params.success}`,
    ];
    this.statsD.increment('cobra.api.requests', tags);
    this.statsD.histogram('cobra.api.latency', params.durationMs, tags);

    if (!params.success) {
      this.statsD.increment('cobra.api.errors', tags);
    }
  }

  /** Track an AI token usage metric. */
  trackTokenUsage(params: {
    model: string;
    provider: string;
    tokensIn: number;
    tokensOut: number;
    durationMs: number;
    success: boolean;
  }): void {
    const tags = [
      `model:${params.model}`,
      `provider:${params.provider}`,
      `success:${params.success}`,
    ];
    this.statsD.count('cobra.ai.tokens_in', params.tokensIn, tags);
    this.statsD.count('cobra.ai.tokens_out', params.tokensOut, tags);
    this.statsD.histogram('cobra.ai.latency', params.durationMs, tags);

    // Also send to New Relic if configured
    if (this.newRelic) {
      this.newRelic.recordModelUsage({
        model: params.model,
        provider: params.provider,
        tokensIn: params.tokensIn,
        tokensOut: params.tokensOut,
        durationMs: params.durationMs,
        success: params.success,
      }).catch(() => { /* fire-and-forget */ });
    }
  }

  /** Send a Datadog event (not metric). */
  async sendDatadogEvent(event: DatadogEvent): Promise<boolean> {
    if (!this.config.datadogApiKey) return false;

    const url = `https://api.${this.config.datadogSite || 'datadoghq.com'}/api/v1/events`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'DD-API-KEY': this.config.datadogApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: event.title,
        text: event.text,
        alert_type: event.alertType || 'info',
        priority: event.priority || 'normal',
        tags: event.tags || [],
        host: event.host,
        aggregation_key: event.aggregationKey,
        source_type_name: event.sourceTypeName || 'cobra-commander',
      }),
    });

    return resp.ok;
  }

  /** Process an incoming alert webhook. */
  processAlertWebhook(payload: Record<string, unknown>): AlertPayload | null {
    const parsed = this.alertReceiver.parseGeneric(payload);
    return this.alertReceiver.processAlert(parsed);
  }

  /** Get the current overlay state for rendering in IDE. */
  getOverlayState(): AlertOverlayState {
    return this.overlay.state;
  }

  /** Render the alert overlay for display. */
  renderOverlay(): string {
    return this.overlay.render();
  }

  /** Get alert counts. */
  getAlertCounts(): Record<string, number> {
    return this.overlay.getAlertCounts();
  }

  /** Shutdown cleanly. */
  shutdown(): void {
    this.statsD.close();
    this.alertReceiver.removeAllListeners();
    this.overlay.clearAll();
  }
}

// ─── Convenience singleton ─────────────────────────────────────────────────

let defaultMonitoring: MonitoringIntegration | null = null;

export function getMonitoring(): MonitoringIntegration {
  if (!defaultMonitoring) {
    defaultMonitoring = new MonitoringIntegration();
  }
  return defaultMonitoring;
}

export function initMonitoring(config: MonitoringConfig): MonitoringIntegration {
  defaultMonitoring = new MonitoringIntegration(config);
  return defaultMonitoring;
}
