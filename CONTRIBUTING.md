# Contributing to Cobra Commander

Thank you for your interest in contributing to Cobra Commander! This document provides guidelines and workflows for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Reporting Bugs](#reporting-bugs)
- [Feature Requests](#feature-requests)
- [Community](#community)
- [License](#license)

## Code of Conduct

Be civil and assume good faith. Technical disagreement is welcome; personal attacks, harassment and bad-faith argument are not. Report unacceptable behaviour by opening a private security advisory or contacting the maintainer through GitHub.

## Getting Started

### Prerequisites

- **Node.js** >= 22.x
- **npm** >= 10.x
- **TypeScript** >= 5.8
- **Git**

### Setup

```bash
# Clone the repository
git clone https://github.com/mshermancyber/cobra-commander-ide.git
cd cobra-commander-ide

# Install dependencies
npm install

# Build the project
npm run build

# Run in development mode
npm run dev
```

### Project Structure

```
src/
├── cli.ts                  # CLI entry point
├── core/                   # Core modules
│   ├── config.ts           # Configuration management
│   ├── diff-analyzer.ts    # Diff analysis engine
│   └── ...
├── providers/              # AI model providers
│   ├── anthropic.ts        # Anthropic (Claude) integration
│   └── openai-compatible.ts # OpenAI-compatible provider
├── tools/                  # Built-in tools
│   ├── file-tools.ts       # File system operations
│   ├── shell-tool.ts       # Shell command execution
│   └── ...
├── api-server/             # HTTP/WS API server
├── remote/                 # Remote control server + web shell backend
├── destro/                 # Support agent (isolated fork of core primitives)
├── models/                 # Model routing and local completion
├── deploy/                 # Air-gapped deployment bundles
└── agents/                 # Background agents
```

Two notes on layout:

- `src/destro/` is an **isolated tree**. It holds deliberately forked copies of core primitives so a
  change to the build pipeline cannot break the thing you use to repair the build pipeline. Porting is
  **downstream only**: core → destro, never the reverse. See `src/destro/FORK-MANIFEST.md`.
- `gui/webshell/` is a separate Vite project with its own `package.json`.

## Development Workflow

1. **Fork the repository** and create a feature branch from `main`.
2. **Make your changes** following the coding standards below.
3. **Add tests** for any new functionality.
4. **Run the test suite** to ensure nothing is broken.
5. **Submit a pull request** with a clear description.

### Branch Naming

- `feature/description` — New features
- `fix/description` — Bug fixes
- `docs/description` — Documentation changes
- `refactor/description` — Code refactoring
- `perf/description` — Performance improvements

### Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
type(scope): description

[optional body]

[optional footer]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`

**Examples:**
```
feat(completion): add multi-line inline completion support
fix(terminal): resolve PTY cleanup on process exit
docs(api): document the session management endpoints
```

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR.
- Include a clear description of what the PR does and why.
- Reference any related issues using `#issue-number`.
- Ensure CI passes (build, lint, test).
- Add or update documentation as needed.
- Keep diffs under 500 lines when possible.
- Respond to review feedback promptly.

### PR Template

```markdown
## Description
Brief description of changes.

## Related Issues
Fixes #123

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactoring

## Testing
Describe how you tested these changes.

## Checklist
- [ ] Code follows project style guidelines
- [ ] Tests added/updated
- [ ] TypeScript compiles (`npx tsc --noEmit`)
- [ ] Documentation updated
```

## Coding Standards

### TypeScript

- Use strict TypeScript (`strict: true` in tsconfig).
- Prefer explicit types over inference for public APIs.
- Use `async/await` over raw Promises.
- Avoid `any` — use `unknown` and type guards.

### Style

- **Indentation:** 2 spaces (not tabs).
- **Semicolons:** Required.
- **Quotes:** Single quotes for strings.
- **Line length:** 120 characters max.
- **File names:** kebab-case (`diff-analyzer.ts`).
- **Export style:** Named exports preferred over default exports.

### Naming

- **Classes/Interfaces:** PascalCase (`DiffAnalyzer`, `ConfigOptions`)
- **Functions/Variables:** camelCase (`analyzeDiff`, `configPath`)
- **Constants:** UPPER_SNAKE_CASE (`MAX_RETRIES`, `DEFAULT_TIMEOUT`)
- **Files:** kebab-case matching the primary export (`diff-analyzer.ts`)
- **Tests:** `*.test.ts` alongside the source or in `__tests__/`

### Imports

```typescript
// Node built-ins first
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Third-party dependencies
import chalk from 'chalk';

// Internal modules
import { DiffAnalyzer } from './diff-analyzer.js';
import { getConfig } from './config.js';
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm run test:node -- src/core/__tests__/diff-analyzer.test.ts

# Watch mode
npx vitest --watch
```

### Writing Tests

- Use `vitest` for unit tests.
- Place test files in `__tests__/` directories or alongside the source as `*.test.ts`.
- Cover new code with tests — aim for 80%+ coverage on new modules.
- Test edge cases, error paths, and boundary conditions.

## Reporting Bugs

When filing a bug report, please include:

1. **Cobra Commander version** (`cobra --version`)
2. **Node.js version** (`node --version`)
3. **Operating system**
4. **Steps to reproduce**
5. **Expected behavior**
6. **Actual behavior**
7. **Relevant logs or error messages**

Use the **Bug Report** issue template on GitHub.

## Feature Requests

Feature requests are welcome! For substantial features, please:

1. Check existing issues and discussions to avoid duplicates.
2. Open a **Feature Request** issue using the template.
3. Describe the problem you're trying to solve, not just the solution.

## Before you open a PR

```bash
npm run typecheck              # must be zero errors
npm test                       # must pass
./scripts/check-no-secrets.sh  # no keys, host addresses or machine paths
```

That third one matters. This repository is portable by design: addresses, ports, paths and credentials
are configuration, never source. A PR that hardcodes your own host will be asked to change.

## Community

- **Issues:** [bug reports and feature requests](https://github.com/mshermancyber/cobra-commander-ide/issues)
- **Security:** see [SECURITY.md](./SECURITY.md) — report vulnerabilities privately, not in an issue

## License

Cobra Commander is licensed under the **GNU General Public License v3.0 or later**. See
[LICENSE](./LICENSE) for the full text.

When you contribute code, you agree that your contributions are licensed under the same terms.

---

**Thank you for contributing to Cobra Commander!** 🐍
