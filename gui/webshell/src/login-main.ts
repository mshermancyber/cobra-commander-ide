// ---------------------------------------------------------------------------
// Login page entry point (separate from the shell)
// ---------------------------------------------------------------------------

import { injectTheme } from './theme.js';
import { createLoginPage } from './login.js';

function main(): void {
  injectTheme();
  createLoginPage();
}

main();
