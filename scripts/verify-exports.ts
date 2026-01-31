#!/usr/bin/env bun
/**
 * Verify that package.json exports match the actual source structure.
 * Ensures all public exports are valid and consistent.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

interface ExportEntry {
  types?: string;
  default?: string;
}

interface PackageJson {
  exports: Record<string, string | ExportEntry>;
  types?: string;
  files?: string[];
}

/**
 * Read and parse package.json from the project root.
 * @returns Parsed package.json content
 */
function readPackageJson(): PackageJson {
  const content = readFileSync(join(ROOT, 'package.json'), 'utf-8');
  return JSON.parse(content) as PackageJson;
}

/**
 * Resolve a relative export path to an absolute filesystem path.
 * @param exportPath - The path from package.json (e.g., "./dist/esm/index.js")
 * @returns Absolute path from project root
 */
function resolveExportPath(exportPath: string): string {
  return join(ROOT, exportPath.replace(/^\.\//, ''));
}

/**
 * Check if a path contains wildcard patterns.
 * @param path - The path to check
 * @returns True if path contains '*'
 */
function isWildcard(path: string): boolean {
  return path.includes('*');
}

/**
 * Check if a path is covered by the files array in package.json.
 * @param exportPath - The export path to check
 * @param files - The files array from package.json
 * @returns True if the path is covered
 */
function isPathCoveredByFiles(exportPath: string, files: string[]): boolean {
  const cleanPath = exportPath.replace(/^\.\//, '');
  return files.some((pattern) => cleanPath.startsWith(pattern.replace(/\/$/, '')));
}

interface CheckResult {
  valid: boolean;
  errors: string[];
  skipped: boolean;
}

/**
 * Validate a single export entry from package.json.
 * Checks file existence, extensions, and files coverage.
 * @param exportName - The export key (e.g., "." or "./transport")
 * @param exportValue - The export value (path string or conditional export object)
 * @param files - The files array from package.json for coverage checking
 * @returns Validation result with errors if any
 */
function checkExport(
  exportValue: string | ExportEntry,
  files: string[],
): CheckResult {
  const errors: string[] = [];

  // Skip wildcard patterns - they are for subpath imports
  if (typeof exportValue === 'string') {
    if (isWildcard(exportValue)) {
      return { valid: true, errors, skipped: true };
    }

    // Check file extension
    if (!exportValue.endsWith('.js')) {
      errors.push(`  Invalid extension: "${exportValue}" must end with .js`);
    }

    // Check files coverage
    if (!isPathCoveredByFiles(exportValue, files)) {
      errors.push(`  Not covered by "files": "${exportValue}"`);
    }

    const jsPath = resolveExportPath(exportValue);
    if (!existsSync(jsPath)) {
      errors.push(`  Missing: ${jsPath}`);
    }
    return { valid: errors.length === 0, errors, skipped: false };
  }

  // Check if any paths contain wildcards
  const hasWildcard =
    (exportValue.types && isWildcard(exportValue.types)) ||
    (exportValue.default && isWildcard(exportValue.default));

  if (hasWildcard) {
    return { valid: true, errors, skipped: true };
  }

  // Conditional export with types/default
  if (exportValue.types) {
    // Check file extension
    if (!exportValue.types.endsWith('.d.ts')) {
      errors.push(`  Invalid types extension: "${exportValue.types}" must end with .d.ts`);
    }

    // Check files coverage
    if (!isPathCoveredByFiles(exportValue.types, files)) {
      errors.push(`  Types not covered by "files": "${exportValue.types}"`);
    }

    const typesPath = resolveExportPath(exportValue.types);
    if (!existsSync(typesPath)) {
      errors.push(`  Missing types: ${typesPath}`);
    }
  }

  if (exportValue.default) {
    // Check file extension
    if (!exportValue.default.endsWith('.js')) {
      errors.push(`  Invalid default extension: "${exportValue.default}" must end with .js`);
    }

    // Check files coverage
    if (!isPathCoveredByFiles(exportValue.default, files)) {
      errors.push(`  Default not covered by "files": "${exportValue.default}"`);
    }

    const defaultPath = resolveExportPath(exportValue.default);
    if (!existsSync(defaultPath)) {
      errors.push(`  Missing default: ${defaultPath}`);
    }
  }

  return { valid: errors.length === 0, errors, skipped: false };
}

/**
 * Verify that the top-level types field matches exports["."].types.
 * @param pkg - The parsed package.json
 * @returns Array of error messages, empty if valid
 */
function checkTypesConsistency(pkg: PackageJson): string[] {
  const errors: string[] = [];
  const rootExport = pkg.exports['.'];

  if (!rootExport || typeof rootExport === 'string') {
    return errors;
  }

  const expectedTypes = rootExport.types;
  const actualTypes = pkg.types;

  if (expectedTypes && actualTypes && expectedTypes !== actualTypes) {
    errors.push(
      `  Mismatch: "types" field is "${actualTypes}" but exports["."].types is "${expectedTypes}"`,
    );
  }

  return errors;
}

/**
 * Main entry point. Validates all exports and reports results.
 * @returns Never returns - calls process.exit()
 */
function main(): void {
  console.log('Verifying package exports...\n');

  const pkg = readPackageJson();
  const files = pkg.files ?? [];
  let allValid = true;
  let errorCount = 0;
  let skippedCount = 0;

  // Check types field consistency
  const typesErrors = checkTypesConsistency(pkg);
  if (typesErrors.length > 0) {
    allValid = false;
    errorCount += typesErrors.length;
    console.log('❌ "types" field consistency:');
    typesErrors.forEach((e) => console.log(e));
    console.log('');
  }

  // Check each export
  for (const [exportName, exportValue] of Object.entries(pkg.exports)) {
    const result = checkExport(exportValue, files);

    if (result.skipped) {
      skippedCount++;
      console.log(`○ Export "${exportName}" (wildcard - skipped)`);
    } else if (!result.valid) {
      allValid = false;
      errorCount += result.errors.length;
      console.log(`❌ Export "${exportName}":`);
      result.errors.forEach((e) => console.log(e));
    } else {
      console.log(`✓ Export "${exportName}"`);
    }
  }

  console.log('');

  if (allValid) {
    console.log(`✅ All exports are valid! (${skippedCount} wildcard pattern(s) skipped)`);
    process.exit(0);
  } else {
    console.log(`❌ Found ${errorCount} error(s)`);
    process.exit(1);
  }
}

main();
