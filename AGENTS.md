# Code Style Guidelines

## Language

- **TypeScript** (ESM).
- Prefer strict typing; avoid `any`.
- Use TypeScript's `strict` mode to catch null/undefined errors.

## TypeScript

- Strict type checking enabled.
- Use ES modules (`import`/`export`).
- All public functions and methods must have explicit return types.

## Naming Conventions

- `PascalCase` for classes, interfaces, and types.
- `camelCase` for functions, methods, and variables.

## File Naming

- All source files should be lowercase with hyphens (kebab-case). E.g., `relay-handler.ts`.
- Test files must be co-located with source files and use the `.test.ts` suffix. E.g., `relay-handler.test.ts`.

## Imports

- Use ES module style (`import { x } from './y.js'`).
- All relative imports must include the `.js` extension to ensure ESM compatibility.

## Error Handling

- Tests must explicitly check for expected errors.

## Formatting

- 2-space indentation.
- Semicolons are required.
- Single quotes (`'`) are preferred over double quotes (`"`).

## Testing

- Tests must be co-located with source files.
- Use descriptive test names that clearly state what is being tested.

## Comments

- **JSDoc** for all public APIs (classes, methods, interfaces, types).
- **Inline comments** for complex or non-obvious logic only.
- Avoid commenting on obvious things or writing lengthy comments.
- Brief comments (1-2 lines) are preferred to explain "why" rather than "what".

## Architecture & Refactoring

- **Keep files concise**: Extract helpers instead of creating "V2" copies.
- **Use existing patterns** for dependency injection via constructor options.
- **Prioritize clear ownership boundaries**: The goal is to ensure each module answers a single architectural question.
- **Modularize around protocol or lifecycle concerns**: Modularization should follow logical sub-flows (e.g., event unwrapping, inbound coordination, outbound routing) rather than arbitrary code splitting.
- **Aim to keep files under ~700 LOC**: This is a heuristic guideline only, not a hard guardrail.
- Split or refactor when it improves clarity or testability.

## Environment

- The library must be compatible with Node.js version 18 or higher.
- Production SDK code must remain browser-safe unless a module is explicitly server-only.
- Do not use Node-only globals such as `Buffer` in non-test source files. Prefer Web Platform APIs such as `TextEncoder`, `TextDecoder`, `crypto.subtle`, and runtime-neutral helpers.
- If a server-oriented module needs encoding utilities, use shared runtime-neutral helpers so the file remains safe to bundle unless intentionally documented otherwise.
- Any new shared transport or protocol path must be reviewed for both Node and browser compatibility before merging.
- Use `bun` as the package manager and test suite.
