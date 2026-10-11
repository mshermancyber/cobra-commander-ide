interface ProcessEntry {
  parentPid: number;
  pid: number;
  command: string;
  registeredAt: number;
}

class ProcessRegistry {
  private entries: ProcessEntry[] = [];

  registerProcess(parentPid: number, childPid: number, command: string): void {
    this.entries.push({
      parentPid,
      pid: childPid,
      command,
      registeredAt: Date.now(),
    });
  }

  unregisterProcess(childPid: number): void {
    this.entries = this.entries.filter(e => e.pid !== childPid);
  }

  getChildren(parentPid: number): Array<{ pid: number; command: string }> {
    return this.entries
      .filter(e => e.parentPid === parentPid)
      .map(e => ({ pid: e.pid, command: e.command }));
  }

  getDescendants(rootPid: number): number[] {
    const result: number[] = [];
    const stack = [rootPid];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const children = this.entries.filter(e => e.parentPid === current);
      for (const child of children) {
        result.push(child.pid);
        stack.push(child.pid);
      }
    }
    return result;
  }

  killTree(rootPid: number): void {
    const descendants = this.getDescendants(rootPid);
    for (const pid of descendants.reverse()) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    if (descendants.length > 0) {
      setTimeout(() => {
        for (const pid of descendants) {
          if (this.isAlive(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
          }
        }
        this.cleanupDead();
      }, 2000);
    }
  }

  cleanupDead(): void {
    this.entries = this.entries.filter(e => this.isAlive(e.pid));
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export const processRegistry = new ProcessRegistry();
