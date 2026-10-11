export const COMMAND_ARITY: Record<string, number> = {
  'npm': 2, 'npx': 2, 'git': 2, 'docker': 2, 'systemctl': 2,
  'apt': 2, 'pip': 2, 'cargo': 2, 'brew': 2, 'yarn': 2, 'pnpm': 2,
  'kubectl': 2, 'az': 2, 'aws': 2, 'gcloud': 2,
  'curl': 1, 'cat': 1, 'grep': 1, 'find': 1, 'ls': 1, 'rm': 1,
  'cp': 1, 'mv': 1, 'mkdir': 1, 'chmod': 1, 'chown': 1,
  'make': 1, 'node': 1, 'python': 1, 'python3': 1, 'ruby': 1,
  'go': 2, 'rustc': 1, 'gcc': 1, 'clang': 1,
};

const DEFAULT_ARITY = 1;

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function stripPath(token: string): string {
  const slashIndex = token.lastIndexOf('/');
  return slashIndex >= 0 ? token.slice(slashIndex + 1) : token;
}

export function extractCommandPrefix(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return '';
  }

  const tokens = trimmed.split(/\s+/);

  // Skip leading environment variable assignments (FOO=bar cmd ...)
  let startIndex = 0;
  while (startIndex < tokens.length && isEnvAssignment(tokens[startIndex])) {
    startIndex++;
  }

  if (startIndex >= tokens.length) {
    return '';
  }

  // The first non-env token is the command — strip any path prefix
  const rawCmd = tokens[startIndex];
  const cmd = stripPath(rawCmd);

  const arity = COMMAND_ARITY[cmd] ?? DEFAULT_ARITY;
  const available = tokens.slice(startIndex, startIndex + arity);

  return available.join(' ');
}
