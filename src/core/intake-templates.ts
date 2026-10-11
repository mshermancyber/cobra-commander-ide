export interface IntakeTemplate {
  id: string;
  name: string;
  description: string;
  category: 'crud' | 'dashboard' | 'monitoring' | 'data-pipeline' | 'api-service' | 'custom';
  skeleton: string;
  defaultPages: string[];
  defaultDataModels: string[];
}

const BUILTIN_TEMPLATES: IntakeTemplate[] = [
  {
    id: 'crud-app',
    name: 'CRUD Application',
    description: 'Standard create/read/update/delete application with entity management',
    category: 'crud',
    skeleton: `## Requirements
1. Entity listing page with search, filter, and pagination
2. Entity detail view with all fields
3. Create/edit forms with validation
4. Delete with confirmation
5. Bulk operations (select multiple, delete, export)`,
    defaultPages: ['List', 'Detail', 'Create/Edit Form', 'Settings'],
    defaultDataModels: ['Primary entity with CRUD fields', 'User (auth)', 'Audit log'],
  },
  {
    id: 'dashboard',
    name: 'Dashboard / Analytics',
    description: 'Data visualization dashboard with charts, stats, and filters',
    category: 'dashboard',
    skeleton: `## Requirements
1. Summary cards with key metrics
2. Time-range selector (24h, 7d, 30d, custom)
3. Filterable data tables
4. Export data (CSV, JSON)`,
    defaultPages: ['Dashboard', 'Reports', 'Settings'],
    defaultDataModels: ['Metrics', 'User (auth)', 'Report configuration'],
  },
  {
    id: 'monitoring',
    name: 'Monitoring / Alerting',
    description: 'Real-time monitoring with alerts and status pages',
    category: 'monitoring',
    skeleton: `## Requirements
1. Real-time status indicators
2. Alert configuration (thresholds, channels)
3. Historical data view with trend lines
4. Incident timeline`,
    defaultPages: ['Status Board', 'Alerts', 'History', 'Configuration'],
    defaultDataModels: ['Monitored target', 'Alert rule', 'Incident', 'User (auth)'],
  },
  {
    id: 'data-pipeline',
    name: 'Data Pipeline / ETL',
    description: 'Data ingestion, transformation, and output pipeline',
    category: 'data-pipeline',
    skeleton: `## Requirements
1. Source configuration (inputs)
2. Transformation rules
3. Output/destination configuration
4. Pipeline run history and logs
5. Scheduling (cron-based or event-driven)`,
    defaultPages: ['Pipelines', 'Run History', 'Sources', 'Destinations', 'Settings'],
    defaultDataModels: ['Pipeline', 'Pipeline run', 'Source config', 'Destination config', 'User (auth)'],
  },
  {
    id: 'api-service',
    name: 'API Service',
    description: 'REST API backend with documentation and key management',
    category: 'api-service',
    skeleton: `## Requirements
1. API endpoint management
2. API key/token generation
3. Usage tracking and rate limits
4. Interactive API documentation
5. Webhook configuration`,
    defaultPages: ['API Explorer', 'Keys', 'Usage', 'Webhooks', 'Settings'],
    defaultDataModels: ['API key', 'Usage record', 'Webhook config', 'User (auth)'],
  },
];

let customTemplates: IntakeTemplate[] = [];

export function listIntakeTemplates(): IntakeTemplate[] {
  return [...BUILTIN_TEMPLATES, ...customTemplates];
}

export function getIntakeTemplate(id: string): IntakeTemplate | null {
  return listIntakeTemplates().find(t => t.id === id) || null;
}

export function addIntakeTemplate(template: IntakeTemplate): void {
  customTemplates = customTemplates.filter(t => t.id !== template.id);
  customTemplates.push(template);
}

export function removeIntakeTemplate(id: string): boolean {
  const before = customTemplates.length;
  customTemplates = customTemplates.filter(t => t.id !== id);
  return customTemplates.length < before;
}

export function matchTemplate(prompt: string): IntakeTemplate | null {
  const lower = prompt.toLowerCase();

  const keywords: Record<string, string[]> = {
    'crud-app': ['crud', 'manage', 'admin panel', 'entity', 'records'],
    'dashboard': ['dashboard', 'analytics', 'metrics', 'charts', 'stats', 'visualization'],
    'monitoring': ['monitor', 'alert', 'status', 'uptime', 'health check', 'incident'],
    'data-pipeline': ['pipeline', 'etl', 'ingest', 'transform', 'import', 'export data'],
    'api-service': ['api', 'rest api', 'endpoint', 'webhook', 'api key'],
  };

  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const [id, words] of Object.entries(keywords)) {
    const score = words.filter(w => lower.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = id;
    }
  }

  if (bestMatch && bestScore > 0) {
    return getIntakeTemplate(bestMatch);
  }

  return null;
}
