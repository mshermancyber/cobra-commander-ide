// ---------------------------------------------------------------------------
// Workspace root
//
// The server decides which directory it serves; the UI must never assume an
// install path. `/api/v1/health` reports it, so panes read it from here and
// fall back to '.' (server-relative) until the first fetch resolves.
// ---------------------------------------------------------------------------

let workspaceRoot = '.';

export function getWorkspaceRoot(): string {
  return workspaceRoot;
}

export function setWorkspaceRoot(dir: string): void {
  if (dir) workspaceRoot = dir;
}

/** Fetch the server's workspace root once at startup. */
export async function initWorkspaceRoot(): Promise<string> {
  try {
    const resp = await fetch('/api/v1/health', { credentials: 'same-origin' });
    if (resp.ok) {
      const data = await resp.json() as { workDir?: string };
      if (data.workDir) workspaceRoot = data.workDir;
    }
  } catch { /* keep the server-relative default */ }
  return workspaceRoot;
}
