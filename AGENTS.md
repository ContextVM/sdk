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
- **Aim to keep files under ~700 LOC**: This is a guideline only (not a hard guardrail).
- Split or refactor when it improves clarity or testability.
- Extract specialized concerns into dedicated modules (e.g., `StatelessModeHandler`, `CorrelationStore`).

## Environment

- The library must be compatible with Node.js version 18 or higher.
- Use `bun` as the package manager and test suite.
