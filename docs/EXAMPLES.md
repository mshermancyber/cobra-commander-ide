# Cobra Commander — Usage Examples

> **Status note for v0.1.0.** This document describes the **interactive slash-command surface**, which
> is *not wired up in this release*. The commands below are design reference, not a working API — none
> of them are registered in the shipped CLI. For what you can actually run today, see
> [../USER-GUIDE.md](../USER-GUIDE.md) and `npx tsx src/cli.ts --help`.

## Example 1: Fix a Bug from an Error Log

**Scenario**: You have a TypeScript error log and want to fix the bugs.

```
> The build is failing with: src/auth.ts(45,3): error TS2322: Type 'string | undefined' is not assignable to type 'string'.
```

Expected output:
```
┌─ Orchestrator ─────────────────────────────────────────────────────┐
│ Analyzing error: TS2322 in src/auth.ts:45                  │
│ Root cause: return type from getUser() can be undefined    │
│ Fix: Add null check or default value                       │
└────────────────────────────────────────────────────────────┘

┌─ Worker ───────────────────────────────────────────────────┐
│ Reading src/auth.ts...                                      │
│ Applying fix at line 45...                                  │
│   - Changed: `return user.name` → `return user.name ?? ''` │
│ ✓ File written: src/auth.ts                                 │
└────────────────────────────────────────────────────────────┘

✓ Bug fixed — 1 file changed
```

---

## Example 2: Add a New API Endpoint

**Scenario**: Add a `/api/users/:id/profile` endpoint to an Express app.

```
> Add a GET /api/users/:id/profile endpoint that returns user profile data. Include input validation and error handling.
```

Expected output:
```
┌─ Orchestrator ─────────────────────────────────────────────────────┐
│ Planning: Add profile endpoint                              │
│ Files needed:                                               │
│   - src/routes/users.ts (or create)                         │
│   - src/controllers/userController.ts                       │
│   - src/validators/userValidator.ts                         │
└────────────────────────────────────────────────────────────┘

┌─ Worker ───────────────────────────────────────────────────┐
│ Reading src/routes/users.ts...                               │
│ Reading src/controllers/userController.ts...                 │
│ Creating src/validators/userValidator.ts...                  │
│ Writing src/routes/users.ts...                               │
│ Writing src/controllers/userController.ts...                 │
│ Writing src/validators/userValidator.ts...                   │
│ ✓ 3 files written                                            │
└────────────────────────────────────────────────────────────┘

✓ Task complete — 3 files changed, 1 new file
```

---

## Example 3: Refactor a Module

**Scenario**: Refactor a monolithic utility module into smaller focused modules.

```
> Refactor src/utils/helpers.ts into separate files: string.ts, array.ts, and date.ts. Keep the same public API by re-exporting from an index.ts.
```

Expected output:
```
┌─ Orchestrator ─────────────────────────────────────────────────────┐
│ Planning: Split helpers.ts into domain modules              │
│ Current: 450 lines in 1 file                                │
│ Target: 3 files + index.ts with re-exports                 │
└────────────────────────────────────────────────────────────┘

┌─ Worker ───────────────────────────────────────────────────┐
│ Reading src/utils/helpers.ts...                              │
│ Analyzing exports...                                         │
│ Creating src/utils/string.ts...                              │
│ Creating src/utils/array.ts...                               │
│ Creating src/utils/date.ts...                                │
│ Creating src/utils/index.ts...                               │
│ Updating imports across project...                           │
│ ✓ 4 files written, 3 files updated                          │
└────────────────────────────────────────────────────────────┘

✓ Refactoring complete — 7 files affected
```

---

## Example 4: Generate Tests for a File

**Scenario**: Generate comprehensive unit tests for a service module.

```
> Generate tests for src/services/userService.ts. Aim for >90% coverage. Use Vitest.
```

Expected output:
```
┌─ Orchestrator ─────────────────────────────────────────────────────┐
│ Analyzing src/services/userService.ts...                    │
│ Detected: 8 exported functions, 3 private helpers           │
│ Test framework: Vitest (from package.json)                  │
└────────────────────────────────────────────────────────────┘

┌─ Worker ───────────────────────────────────────────────────┐
│ Reading src/services/userService.ts...                       │
│ Creating src/__tests__/userService.test.ts...                │
│ Writing test cases:                                          │
│   ✓ createUser() - success case                              │
│   ✓ createUser() - duplicate email                           │
│   ✓ getUserById() - found                                    │
│   ✓ getUserById() - not found                                │
│   ✓ updateUser() - partial update                            │
│   ✓ updateUser() - invalid data                              │
│   ✓ deleteUser() - success                                   │
│   ✓ listUsers() - pagination                                 │
│ ✓ Test file written: 8 test cases                            │
└────────────────────────────────────────────────────────────┘

✓ Tests generated — run with: npx vitest run src/__tests__/userService.test.ts
```

---

## Example 5: Code Review via `/review`

**Scenario**: Review uncommitted changes before pushing.

```
> /review
```

Expected output:
```
┌─ Orchestrator Code Review ─────────────────────────────────────────┐
│ Reviewing 5 files changed, 120 insertions, 30 deletions     │
│                                                              │
│ src/auth.ts:                                                 │
│ ⚠️ Security: JWT secret hardcoded (line 12)                  │
│ 💡 Suggestion: Use environment variable                      │
│                                                              │
│ src/routes/users.ts:                                         │
│ ✅ Good: Input validation present                             │
│ ⚠️ Missing rate limiting on POST /users                      │
│                                                              │
│ src/services/email.ts:                                       │
│ ❌ Bug: Missing null check on user.email (line 87)           │
│                                                              │
│ Overall: 2 issues, 1 bug, 1 security concern                 │
│ Score: 7/10                                                  │
└────────────────────────────────────────────────────────────┘
```

---

## Example 6: Multi-File Editing with `/compose`

**Scenario**: Add a new feature that touches multiple files simultaneously.

```
> /compose "Add email notification support. Create a NotificationService that sends emails via SendGrid. Add a notification preference toggle to the user settings page."
```

Expected output:
```
┌─ Orchestrator ─────────────────────────────────────────────────────┐
│ Composer session created: comp_a1b2c3                       │
│ Files to edit:                                              │
│   - src/services/notificationService.ts (new)               │
│   - src/controllers/settingsController.ts                   │
│   - src/views/settings.ejs                                  │
│   - src/routes/settings.ts                                  │
└────────────────────────────────────────────────────────────┘

> /compose-preview

┌─ Composer Preview ─────────────────────────────────────────┐
│ File: src/services/notificationService.ts                   │
│ ────────────────────────────────────────────────            │
│ + import { sendEmail } from './emailProvider';              │
│ + export class NotificationService { ... }                  │
│                                                              │
│ File: src/controllers/settingsController.ts                 │
│ ────────────────────────────────────────────────            │
│ ... (12 changes)                                            │
└────────────────────────────────────────────────────────────┘

> /compose-apply

✓ Applied 4 file edit(s)
```

---

## Example 7: Background Task with `/bg`

**Scenario**: Run a long-running refactoring task in the background while you continue working.

```
> /bg "Refactor all console.log statements to use the winston logger throughout the project"
```

Expected output:
```
┌─ Background Job ───────────────────────────────────────────┐
│ Job created: bg_k8m9n0                                      │
│ Status: running                                             │
│ You can continue working. Use /jobs to check status.        │
└────────────────────────────────────────────────────────────┘

> (continue working on other tasks...)

> /jobs

┌─ Background Jobs ──────────────────────────────────────────┐
│ bg_k8m9n0: completed ✓                                      │
│   Files changed: 12                                         │
│   Duration: 45s                                             │
└────────────────────────────────────────────────────────────┘
```

---

## Example 8: Security Scan with `/dv`

**Scenario**: Run a full security scan on the codebase.

```
> /dv dashboard
```

Expected output:
```
┌─ the security scanner Dashboard ─────────────────────────────────┐
│ Scanning project...                                          │
│                                                              │
│ SAST Scan Results:                                           │
│   Critical: 2                                                │
│   High:     5                                                │
│   Medium:   8                                                │
│   Low:      12                                               │
│                                                              │
│ Top Findings:                                                 │
│   🔴 SQL Injection in src/queries/userQueries.ts:45          │
│   🔴 Hardcoded Secret in src/config.ts:12                    │
│   🟠 XSS Vulnerability in src/views/profile.ejs:78           │
│                                                              │
│ Run /scan fix to auto-remediate                              │
└────────────────────────────────────────────────────────────┘
```

---

## Example 9: Batch Operations with `/batch`

**Scenario**: Run a sequence of dependent tasks.

```
> /batch "Add input validation middleware, implement user CRUD endpoints, write integration tests"
```

Expected output:
```
┌─ Batch Orchestrator ───────────────────────────────────────┐
│ Task 1/3: Add input validation middleware                   │
│   ✓ Created src/middleware/validate.ts                      │
│   ✓ Updated src/app.ts                                      │
│                                                              │
│ Task 2/3: Implement user CRUD endpoints                     │
│   ✓ Created src/routes/users.ts                             │
│   ✓ Created src/controllers/userController.ts               │
│   ✓ Created src/services/userService.ts                     │
│                                                              │
│ Task 3/3: Write integration tests                           │
│   ✓ Created src/__tests__/users.integration.test.ts         │
│   ✓ All tests passing (12/12)                               │
│                                                              │
│ Batch complete — 6 files created, 1 file modified           │
│ Total duration: 2m 34s                                      │
└────────────────────────────────────────────────────────────┘
```

---

## Example 10: Goal Mode with `/goal`

**Scenario**: Iteratively improve code until acceptance criteria are met.

```
> /goal "All unit tests pass and code coverage is above 80%"
```

Expected output:
```
┌─ Goal Mode ────────────────────────────────────────────────┐
│ Goal: All unit tests pass and code coverage is above 80%    │
│                                                              │
│ Iteration 1:                                                 │
│   Running tests... 45 passed, 3 failed                       │
│   Coverage: 62%                                              │
│   Fixing failing tests...                                    │
│                                                              │
│ Iteration 2:                                                 │
│   Running tests... 48 passed, 0 failed ✓                     │
│   Coverage: 62%                                              │
│   Adding missing tests...                                    │
│                                                              │
│ Iteration 3:                                                 │
│   Running tests... 52 passed, 0 failed ✓                     │
│   Coverage: 83% ✓                                            │
│                                                              │
│ ✓ Goal achieved in 3 iterations                              │
│   Tests: 52 passing                                          │
│   Coverage: 83%                                              │
│   Files changed: 5                                           │
└────────────────────────────────────────────────────────────┘

> /goal status

┌─ Goal Progress ────────────────────────────────────────────┐
│ Status: ✅ Complete                                          │
│ Iterations: 3                                               │
│ Duration: 4m 12s                                            │
│ Criteria met:                                                │
│   ✓ All tests pass (52/52)                                   │
│   ✓ Coverage >80% (83%)                                     │
└────────────────────────────────────────────────────────────┘
```
