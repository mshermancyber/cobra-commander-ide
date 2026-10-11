/**
 * Endpoint construction for OpenAI-compatible gateways.
 *
 * Gateways are configured in wildly different shapes — `https://api.openai.com/v1`,
 * `https://api.openai.com`, a corporate proxy on a sub-path, an Azure-style
 * deployment URL, or `http://localhost:11434/v1` for a local runtime. Appending
 * a bare `/v1/chat/completions` to whatever the operator typed produces
 * `/v1/v1/chat/completions` half the time, so every LLM call goes through here.
 */

/** Join a gateway base URL with an API path, without duplicating a version segment. */
export function endpointUrl(baseUrl: string, path: string): string {
  const base = (baseUrl || '').replace(/\/+$/, '');
  const suffix = path.replace(/^\/+/, '');

  const versioned = suffix.match(/^(v\d+)\/(.*)$/);
  if (versioned) {
    const [, version, rest] = versioned;
    if (new RegExp(`/${version}$`).test(base)) return `${base}/${rest}`;
    return `${base}/${version}/${rest}`;
  }

  return `${base}/${suffix}`;
}

/** Chat Completions endpoint for a gateway base URL. */
export function chatCompletionsUrl(baseUrl: string): string {
  return endpointUrl(baseUrl, 'v1/chat/completions');
}

/** Legacy text Completions endpoint, used by fill-in-the-middle providers. */
export function completionsUrl(baseUrl: string): string {
  return endpointUrl(baseUrl, 'v1/completions');
}

/** Models listing endpoint, used for connectivity checks. */
export function modelsUrl(baseUrl: string): string {
  return endpointUrl(baseUrl, 'v1/models');
}
