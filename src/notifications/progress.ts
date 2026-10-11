import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type NotificationChannel = 'slack' | 'email' | 'terminal' | 'desktop' | 'webhook';

export type NotificationEventType =
  | 'task-started'
  | 'task-progress'
  | 'task-completed'
  | 'task-failed'
  | 'milestone-reached'
  | 'review-requested'
  | 'build-complete'
  | 'deploy-complete'
  | 'error-occurred'
  | 'agent-started'
  | 'agent-paused'
  | 'agent-resumed'
  | 'agent-finished';

export interface ProgressEvent {
  id: string;
  type: NotificationEventType;
  /** Human-readable title */
  title: string;
  /** Detailed message body */
  body: string;
  /** Associated task or agent ID */
  taskId?: string;
  /** Session ID */
  sessionId?: string;
  /** Progress percentage 0-100 */
  percentComplete?: number;
  /** Milestone label, e.g., "Phase 2: Implementation" */
  milestone?: string;
  /** Timestamp of the event */
  timestamp: number;
  /** Arbitrary metadata payload */
  metadata?: Record<string, unknown>;
}

export interface UserChannelPreference {
  channel: NotificationChannel;
  enabled: boolean;
  /** Filter: only send events matching these types (empty = all) */
  eventTypes: NotificationEventType[];
  /** Minimum severity to notify on */
  minSeverity: 'info' | 'warning' | 'error' | 'critical';
  /** Channel-specific configuration */
  config: ChannelConfig;
}

export interface ChannelConfig {
  // Slack
  slackWebhookUrl?: string;
  slackChannel?: string;
  slackMentionUsers?: string[];
  // Email
  emailTo?: string[];
  emailCc?: string[];
  emailBcc?: string[];
  emailFrom?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  sendgridApiKey?: string;
  // Webhook
  webhookUrl?: string;
  webhookHeaders?: Record<string, string>;
}

export interface UserPreferences {
  /** Unique user ID */
  userId: string;
  /** Per-channel preferences */
  channels: UserChannelPreference[];
  /** Quiet hours: don't send notifications between these hours (UTC) */
  quietHours?: { start: number; end: number };
  /** Maximum notifications per hour */
  rateLimit?: number;
  /** Last updated */
  updatedAt: number;
}

export interface EmailTemplate {
  subject: string;
  htmlBody: string;
  textBody: string;
}

export interface NotificationResult {
  channel: NotificationChannel;
  success: boolean;
  error?: string;
  deliveredAt: number;
}

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const PREFS_DIR = join(homedir(), '.cobra-commander');
const PREFS_FILE = 'progress-notify-prefs.json';

const DEFAULT_PREFS: UserPreferences = {
  userId: 'default',
  channels: [
    {
      channel: 'terminal',
      enabled: true,
      eventTypes: [],
      minSeverity: 'info',
      config: {},
    },
    {
      channel: 'desktop',
      enabled: false,
      eventTypes: [],
      minSeverity: 'warning',
      config: {},
    },
    {
      channel: 'slack',
      enabled: false,
      eventTypes: [],
      minSeverity: 'warning',
      config: {},
    },
    {
      channel: 'email',
      enabled: false,
      eventTypes: ['task-failed', 'error-occurred', 'agent-finished'],
      minSeverity: 'error',
      config: {},
    },
    {
      channel: 'webhook',
      enabled: false,
      eventTypes: [],
      minSeverity: 'info',
      config: {},
    },
  ],
  rateLimit: 60,
  updatedAt: 0,
};

const EVENT_SEVERITY: Record<NotificationEventType, UserChannelPreference['minSeverity']> = {
  'task-started': 'info',
  'task-progress': 'info',
  'task-completed': 'info',
  'task-failed': 'error',
  'milestone-reached': 'info',
  'review-requested': 'warning',
  'build-complete': 'info',
  'deploy-complete': 'info',
  'error-occurred': 'critical',
  'agent-started': 'info',
  'agent-paused': 'warning',
  'agent-resumed': 'info',
  'agent-finished': 'info',
};

const SEVERITY_ORDER: Record<UserChannelPreference['minSeverity'], number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

// ──────────────────────────────────────────────
// Progress Event Bus
// ──────────────────────────────────────────────

export class ProgressEventBus extends EventEmitter {
  private prefs: UserPreferences;
  private notificationHistory: Array<{ eventId: string; timestamp: number }> = [];
  private hourlyCount = 0;
  private hourResetTimer: ReturnType<typeof setInterval> | null = null;

  constructor(userId?: string) {
    super();
    this.prefs = loadPreferences(userId);
    this.startRateLimitTimer();
  }

  // ── event emission ──

  /**
   * Emit a progress event. This triggers notification delivery to all
   * enabled channels based on user preferences.
   */
  async emitProgress(event: Omit<ProgressEvent, 'id' | 'timestamp'>): Promise<NotificationResult[]> {
    if (this.isInQuietHours()) return [];

    if (!this.checkRateLimit()) {
      return [{
        channel: 'terminal',
        success: false,
        error: 'Rate limit exceeded',
        deliveredAt: Date.now(),
      }];
    }

    const fullEvent: ProgressEvent = {
      ...event,
      id: randomUUID(),
      timestamp: Date.now(),
    };

    // Emit to listeners
    this.emit('progress', fullEvent);
    this.emit(event.type, fullEvent);

    // Track for rate limiting
    this.notificationHistory.push({ eventId: fullEvent.id, timestamp: fullEvent.timestamp });
    this.hourlyCount++;

    // Deliver to enabled channels
    const results: NotificationResult[] = [];
    const enabledChannels = this.prefs.channels.filter((ch) => ch.enabled);

    for (const channelPref of enabledChannels) {
      if (!this.shouldDeliver(fullEvent, channelPref)) continue;

      const result = await this.deliverToChannel(fullEvent, channelPref);
      results.push(result);
    }

    return results;
  }

  /**
   * Convenience method: emit a milestone event.
   */
  async milestoneReached(
    taskId: string,
    milestone: string,
    percentComplete: number,
    metadata?: Record<string, unknown>,
  ): Promise<NotificationResult[]> {
    return this.emitProgress({
      type: 'milestone-reached',
      title: `Milestone: ${milestone}`,
      body: `Task ${taskId} has reached milestone: ${milestone} (${percentComplete}% complete)`,
      taskId,
      milestone,
      percentComplete,
      metadata,
    });
  }

  /**
   * Convenience: task completed.
   */
  async taskCompleted(
    taskId: string,
    taskName: string,
    success: boolean,
    details?: string,
  ): Promise<NotificationResult[]> {
    return this.emitProgress({
      type: success ? 'task-completed' : 'task-failed',
      title: success ? `Task Complete: ${taskName}` : `Task Failed: ${taskName}`,
      body: details ?? (success ? `${taskName} completed successfully.` : `${taskName} failed.`),
      taskId,
      percentComplete: success ? 100 : undefined,
    });
  }

  /**
   * Convenience: agent lifecycle events.
   */
  async agentLifecycle(
    agentId: string,
    status: 'started' | 'paused' | 'resumed' | 'finished',
    sessionId?: string,
  ): Promise<NotificationResult[]> {
    const typeMap: Record<string, NotificationEventType> = {
      started: 'agent-started',
      paused: 'agent-paused',
      resumed: 'agent-resumed',
      finished: 'agent-finished',
    };

    return this.emitProgress({
      type: typeMap[status],
      title: `Agent ${status}: ${agentId}`,
      body: `Agent ${agentId} has ${status}.`,
      taskId: agentId,
      sessionId,
    });
  }

  // ── channel delivery ──

  private shouldDeliver(event: ProgressEvent, pref: UserChannelPreference): boolean {
    // Check event type filter
    if (pref.eventTypes.length > 0 && !pref.eventTypes.includes(event.type)) {
      return false;
    }

    // Check severity threshold
    const eventSev = EVENT_SEVERITY[event.type];
    if (SEVERITY_ORDER[eventSev] < SEVERITY_ORDER[pref.minSeverity]) {
      return false;
    }

    return true;
  }

  private async deliverToChannel(
    event: ProgressEvent,
    pref: UserChannelPreference,
  ): Promise<NotificationResult> {
    const start = Date.now();
    try {
      switch (pref.channel) {
        case 'slack':
          await this.sendSlack(event, pref.config);
          break;
        case 'email':
          await this.sendEmail(event, pref.config);
          break;
        case 'terminal':
          this.sendTerminal(event);
          break;
        case 'desktop':
          await this.sendDesktop(event);
          break;
        case 'webhook':
          await this.sendWebhook(event, pref.config);
          break;
      }
      return { channel: pref.channel, success: true, deliveredAt: Date.now() };
    } catch (err) {
      return {
        channel: pref.channel,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        deliveredAt: Date.now(),
      };
    }
  }

  // ── slack ──

  private async sendSlack(event: ProgressEvent, config: ChannelConfig): Promise<void> {
    const webhookUrl = config.slackWebhookUrl;
    if (!webhookUrl) {
      // console.warn('[progress] Slack channel enabled but no webhook URL configured');
      return;
    }

    const colorMap: Record<string, string> = {
      'task-completed': 'good',
      'task-failed': 'danger',
      'error-occurred': 'danger',
      'milestone-reached': '#439FE0',
      'task-started': '#3AA3E3',
      'task-progress': '#3AA3E3',
      'agent-started': '#3AA3E3',
      'agent-finished': 'good',
      'agent-paused': 'warning',
      'review-requested': 'warning',
      'build-complete': 'good',
      'deploy-complete': 'good',
    };

    const mentionText = config.slackMentionUsers?.length
      ? config.slackMentionUsers.map((u) => `<@${u}>`).join(' ') + '\n'
      : '';

    const channelTag = config.slackChannel ? `#${config.slackChannel}` : '#general';

    const payload = {
      channel: config.slackChannel ?? 'general',
      attachments: [
        {
          color: colorMap[event.type] ?? '#666666',
          title: event.title,
          text: mentionText + event.body,
          fields: [
            ...(event.taskId ? [{ title: 'Task', value: event.taskId, short: true }] : []),
            ...(event.milestone ? [{ title: 'Milestone', value: event.milestone, short: true }] : []),
            ...(event.percentComplete !== undefined
              ? [{ title: 'Progress', value: `${event.percentComplete}%`, short: true }]
              : []),
          ],
          footer: `Cobra Commander • ${new Date(event.timestamp).toISOString()}`,
          ts: Math.floor(event.timestamp / 1000),
        },
      ],
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook returned ${response.status}: ${await response.text()}`);
    }
  }

  // ── email ──

  private async sendEmail(event: ProgressEvent, config: ChannelConfig): Promise<void> {
    const template = this.renderEmailTemplate(event);

    if (config.sendgridApiKey) {
      await this.sendViaSendgrid(config, template);
    } else if (config.smtpHost) {
      await this.sendViaSmtp(config, template);
    } else {
      // console.warn('[progress] Email channel enabled but no SMTP or SendGrid config');
      return;
    }
  }

  private renderEmailTemplate(event: ProgressEvent): EmailTemplate {
    const severity = EVENT_SEVERITY[event.type];
    const iconMap: Record<string, string> = {
      info: 'ℹ️',
      warning: '⚠️',
      error: '❌',
      critical: '🚨',
    };

    const icon = iconMap[severity] ?? '📌';
    const subject = `[Cobra Commander] ${icon} ${event.title}`;

    const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: ${severity === 'critical' ? '#DC3545' : severity === 'error' ? '#DC3545' : '#1a1a2e'}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
    <h2 style="margin:0;">${icon} ${escapeHtml(event.title)}</h2>
  </div>
  <div style="border: 1px solid #e0e0e0; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
    <p>${escapeHtml(event.body)}</p>
    <table style="width:100%; margin-top: 16px; border-collapse: collapse;">
      ${event.taskId ? `<tr><td style="padding:4px 0; color:#666;">Task ID</td><td>${escapeHtml(event.taskId)}</td></tr>` : ''}
      ${event.milestone ? `<tr><td style="padding:4px 0; color:#666;">Milestone</td><td>${escapeHtml(event.milestone)}</td></tr>` : ''}
      ${event.percentComplete !== undefined ? `<tr><td style="padding:4px 0; color:#666;">Progress</td><td>${event.percentComplete}%</td></tr>` : ''}
    </table>
    <hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;">
    <p style="color: #999; font-size: 12px;">Sent by Cobra Commander at ${new Date(event.timestamp).toISOString()}</p>
  </div>
</body>
</html>`.trim();

    const textBody = [
      `${icon} ${event.title}`,
      '',
      event.body,
      '',
      event.taskId ? `Task: ${event.taskId}` : '',
      event.milestone ? `Milestone: ${event.milestone}` : '',
      event.percentComplete !== undefined ? `Progress: ${event.percentComplete}%` : '',
      '',
      `--`,
      `Cobra Commander • ${new Date(event.timestamp).toISOString()}`,
    ].filter(Boolean).join('\n');

    return { subject, htmlBody, textBody };
  }

  private async sendViaSendgrid(
    config: ChannelConfig,
    template: EmailTemplate,
  ): Promise<void> {
    const payload = {
      personalizations: [
        {
          to: (config.emailTo ?? []).map((e) => ({ email: e })),
          cc: (config.emailCc ?? []).map((e) => ({ email: e })),
          bcc: (config.emailBcc ?? []).map((e) => ({ email: e })),
          subject: template.subject,
        },
      ],
      from: { email: config.emailFrom ?? 'cobra@localhost' },
      content: [
        { type: 'text/plain', value: template.textBody },
        { type: 'text/html', value: template.htmlBody },
      ],
    };

    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.sendgridApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`SendGrid returned ${response.status}: ${await response.text()}`);
    }
  }

  private async sendViaSmtp(
    config: ChannelConfig,
    template: EmailTemplate,
  ): Promise<void> {
    // SMTP is not natively available in Node.js without external libs.
    // This is a placeholder that logs — in production, integrate with nodemailer.
    // For now we record that an SMTP send was attempted.
    const connInfo = `${config.smtpHost}:${config.smtpPort ?? 587}`;
    if (!config.emailTo || config.emailTo.length === 0) {
      throw new Error('No email recipients configured');
    }
    // In a real implementation, this would use a library like nodemailer.
    // The template is ready to be injected into any SMTP transport.
    throw new Error(
      `SMTP send to ${config.emailTo.join(', ')} via ${connInfo}. ` +
      `Integrate nodemailer for production use. Subject: ${template.subject}`,
    );
  }

  // ── terminal ──

  private sendTerminal(event: ProgressEvent): void {
    const iconMap: Record<string, string> = {
      info: 'ℹ',
      warning: '⚠',
      error: '✖',
      critical: '‼',
    };
    const severity = EVENT_SEVERITY[event.type];
    const icon = iconMap[severity] ?? '•';
    const timestamp = new Date(event.timestamp).toLocaleTimeString();
    const progress = event.percentComplete !== undefined ? ` [${event.percentComplete}%]` : '';
    const milestone = event.milestone ? ` | ${event.milestone}` : '';

    console.log(`\n${icon} [${timestamp}] ${event.title}${progress}${milestone}`);
    console.log(`  ${event.body}\n`);
  }

  // ── desktop ──

  private async sendDesktop(event: ProgressEvent): Promise<void> {
    // Desktop notifications use the same platform-specific approach
    // as src/core/notification.ts. Cross-reference that implementation.
    const platform = process.platform;
    const title = event.title;
    const body = event.body;

    if (platform === 'linux') {
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync('notify-send', ['--urgency=normal', title, body], { timeout: 5000, stdio: 'ignore' });
      } catch {
        // notify-send not available
      }
    } else if (platform === 'darwin') {
      const { execFileSync } = await import('node:child_process');
      try {
        const script = `display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`;
        execFileSync('osascript', ['-e', script], { timeout: 5000, stdio: 'ignore' });
      } catch {
        // osascript not available
      }
    } else if (platform === 'win32') {
      const { execFileSync } = await import('node:child_process');
      try {
        const escapedTitle = title.replace(/"/g, '`"');
        const escapedBody = body.replace(/"/g, '`"');
        const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $textNodes = $template.GetElementsByTagName("text"); $textNodes.Item(0).AppendChild($template.CreateTextNode("${escapedTitle}")) > $null; $textNodes.Item(1).AppendChild($template.CreateTextNode("${escapedBody}")) > $null; $toast = [Windows.UI.Notifications.ToastNotification]::new($template); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier().Show($toast);`;
        execFileSync('powershell', ['-Command', script], { timeout: 5000, stdio: 'ignore' });
      } catch {
        // PowerShell toast not available
      }
    }
  }

  // ── webhook ──

  private async sendWebhook(event: ProgressEvent, config: ChannelConfig): Promise<void> {
    if (!config.webhookUrl) {
      throw new Error('No webhook URL configured');
    }

    const payload = {
      event: event.type,
      title: event.title,
      body: event.body,
      taskId: event.taskId,
      sessionId: event.sessionId,
      milestone: event.milestone,
      percentComplete: event.percentComplete,
      timestamp: new Date(event.timestamp).toISOString(),
      metadata: event.metadata,
    };

    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.webhookHeaders ?? {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}: ${await response.text()}`);
    }
  }

  // ── rate limiting & quiet hours ──

  private checkRateLimit(): boolean {
    const limit = this.prefs.rateLimit ?? 60;
    return this.hourlyCount < limit;
  }

  private startRateLimitTimer(): void {
    if (this.hourResetTimer) clearInterval(this.hourResetTimer);
    this.hourResetTimer = setInterval(() => {
      this.hourlyCount = 0;
      // Prune old history entries
      const cutoff = Date.now() - 3600_000;
      this.notificationHistory = this.notificationHistory.filter((h) => h.timestamp > cutoff);
    }, 3600_000);
  }

  private isInQuietHours(): boolean {
    const qh = this.prefs.quietHours;
    if (!qh) return false;
    const now = new Date();
    const hour = now.getUTCHours();
    if (qh.start <= qh.end) {
      return hour >= qh.start && hour < qh.end;
    }
    // Wraps around midnight
    return hour >= qh.start || hour < qh.end;
  }

  // ── cleanup ──

  close(): void {
    if (this.hourResetTimer) {
      clearInterval(this.hourResetTimer);
      this.hourResetTimer = null;
    }
    this.removeAllListeners();
  }
}

// ──────────────────────────────────────────────
// User Preference Store
// ──────────────────────────────────────────────

/**
 * Load user notification preferences from disk.
 */
export function loadPreferences(userId?: string): UserPreferences {
  const prefsPath = join(PREFS_DIR, PREFS_FILE);
  try {
    if (existsSync(prefsPath)) {
      const raw = readFileSync(prefsPath, 'utf-8');
      const parsed = JSON.parse(raw) as UserPreferences;
      if (userId && parsed.userId !== userId) {
        // Different user — start with defaults but keep the userId
        return { ...DEFAULT_PREFS, userId };
      }
      return parsed;
    }
  } catch {
    // invalid file — return defaults
  }
  return userId ? { ...DEFAULT_PREFS, userId } : { ...DEFAULT_PREFS };
}

/**
 * Save user notification preferences to disk.
 */
export function savePreferences(prefs: UserPreferences): void {
  if (!existsSync(PREFS_DIR)) {
    mkdirSync(PREFS_DIR, { recursive: true });
  }
  prefs.updatedAt = Date.now();
  const prefsPath = join(PREFS_DIR, PREFS_FILE);
  writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), 'utf-8');
}

/**
 * Enable or disable a notification channel for the current user.
 */
export function setChannelEnabled(
  prefs: UserPreferences,
  channel: NotificationChannel,
  enabled: boolean,
): UserPreferences {
  let ch = prefs.channels.find((c) => c.channel === channel);
  if (!ch) {
    ch = {
      channel,
      enabled,
      eventTypes: [],
      minSeverity: 'info',
      config: {},
    };
    prefs.channels.push(ch);
  } else {
    ch.enabled = enabled;
  }
  savePreferences(prefs);
  return prefs;
}

/**
 * Update channel configuration.
 */
export function updateChannelConfig(
  prefs: UserPreferences,
  channel: NotificationChannel,
  config: Partial<ChannelConfig>,
): UserPreferences {
  let ch = prefs.channels.find((c) => c.channel === channel);
  if (!ch) {
    ch = {
      channel,
      enabled: true,
      eventTypes: [],
      minSeverity: 'info',
      config: {},
    };
    prefs.channels.push(ch);
  }
  ch.config = { ...ch.config, ...config };
  savePreferences(prefs);
  return prefs;
}

/**
 * Opt-in to a specific channel with granular event type filters.
 */
export function optInChannel(
  prefs: UserPreferences,
  channel: NotificationChannel,
  eventTypes: NotificationEventType[],
  minSeverity?: UserChannelPreference['minSeverity'],
): UserPreferences {
  let ch = prefs.channels.find((c) => c.channel === channel);
  if (!ch) {
    ch = {
      channel,
      enabled: true,
      eventTypes,
      minSeverity: minSeverity ?? 'info',
      config: {},
    };
    prefs.channels.push(ch);
  } else {
    ch.enabled = true;
    ch.eventTypes = eventTypes;
    if (minSeverity) ch.minSeverity = minSeverity;
  }
  savePreferences(prefs);
  return prefs;
}

/**
 * Opt-out of a channel entirely.
 */
export function optOutChannel(
  prefs: UserPreferences,
  channel: NotificationChannel,
): UserPreferences {
  return setChannelEnabled(prefs, channel, false);
}

// ──────────────────────────────────────────────
// HTML escape utility
// ──────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
