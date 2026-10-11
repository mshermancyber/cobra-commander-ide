export interface PathPolicy {
  allowed?: string[];
  denied?: string[];
}

export interface PermissionResult {
  permitted: boolean;
  reason?: string;
}

function matchPattern(filePath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(prefix + '/');
  }
  if (pattern.startsWith('**/')) {
    const suffix = pattern.slice(3);
    return filePath.endsWith(suffix) || filePath.includes('/' + suffix);
  }
  if (pattern.includes('*')) {
    const regex = new RegExp(
      '^' + pattern.replace(/\./g, '\\.').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*') + '$'
    );
    return regex.test(filePath);
  }
  return filePath === pattern || filePath.startsWith(pattern + '/');
}

export function checkPathPermission(filePath: string, policy: PathPolicy): PermissionResult {
  if (policy.denied?.length) {
    for (const pattern of policy.denied) {
      if (matchPattern(filePath, pattern)) {
        return { permitted: false, reason: `path matches denied pattern: ${pattern}` };
      }
    }
  }

  if (policy.allowed?.length) {
    for (const pattern of policy.allowed) {
      if (matchPattern(filePath, pattern)) {
        return { permitted: true };
      }
    }
    return { permitted: false, reason: 'path not in allowed list' };
  }

  return { permitted: true };
}
