import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Readline Callback Adapter
// Promisified wrapper around Node.js readline's callback-based question API.
// Provides a clean async interface for CLI user prompts.
// ---------------------------------------------------------------------------

export interface ReadlineAdapter {
  /** Prompt the user with a question and return their answer. */
  question(prompt: string): Promise<string>;
  /** Prompt for sensitive input (masks via muted stdout). Returns raw input. */
  questionSecret(prompt: string): Promise<string>;
  /** Write a status message to stderr (keeps stdout clean for piping). */
  status(message: string): void;
  /** Close the readline interface. */
  close(): void;
}

/**
 * Create a readline callback adapter bound to stdin/stdout.
 * Uses the callback-based readline API, wrapped in Promises for ergonomic use.
 */
export function createReadlineAdapter(): ReadlineAdapter {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    question(prompt: string): Promise<string> {
      return new Promise((resolve) => {
        rl.question(prompt, (answer: string) => {
          resolve(answer.trim());
        });
      });
    },

    questionSecret(prompt: string): Promise<string> {
      return new Promise((resolve) => {
        // Use stdin raw mode to suppress echo for password input.
        // Fall back gracefully if stdin is not a TTY.
        const stdin = process.stdin;
        const stdout = process.stdout;
        const isTTY = stdout.isTTY;

        if (isTTY) {
          stdout.write(prompt);
          const previousRaw = stdin.isRaw;
          stdin.setRawMode?.(true);
          stdin.resume();

          let buf = '';
          const onData = (chunk: Buffer): void => {
            const str = chunk.toString();
            for (const ch of str) {
              if (ch === '\r' || ch === '\n') {
                stdout.write('\n');
                stdin.removeListener('data', onData);
                if (previousRaw === false) stdin.setRawMode?.(false);
                stdin.pause();
                resolve(buf);
                return;
              }
              if (ch === '\x7f' || ch === '\b') {
                // Backspace
                if (buf.length > 0) {
                  buf = buf.slice(0, -1);
                  stdout.write('\b \b');
                }
                return;
              }
              if (ch === '\x03') {
                // Ctrl+C
                stdout.write('\n');
                stdin.removeListener('data', onData);
                if (previousRaw === false) stdin.setRawMode?.(false);
                stdin.pause();
                resolve('');
                return;
              }
              buf += ch;
              stdout.write('*');
            }
          };
          stdin.on('data', onData);
        } else {
          // Non-TTY fallback: use standard readline question
          rl.question(prompt, (answer: string) => {
            resolve(answer.trim());
          });
        }
      });
    },

    status(message: string): void {
      process.stderr.write(`[cli-auth] ${message}\n`);
    },

    close(): void {
      rl.close();
    },
  };
}
