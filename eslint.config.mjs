// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.strict,
  importPlugin.flatConfigs.recommended,
  {
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-unused-expressions': 'error',
      'no-unused-vars': 'off', // Turn off base rule in favor of @typescript-eslint/no-unused-vars
      semi: ['error', 'always'],
      quotes: ['error', 'single'],

      // Core dependency checking: Ensure all imported packages are declared in package.json
      'import/no-extraneous-dependencies': [
        'error',
        {
          devDependencies: [
            '**/*.test.ts',
            '**/*.spec.ts',
            '**/__mocks__/**',
            'eslint.config.mjs',
          ],
          optionalDependencies: false,
          peerDependencies: false,
        },
      ],

      // Disable all other import rules - rely on TypeScript for import validation
      'import/named': 'off',
      'import/namespace': 'off',
      'import/default': 'off',
      'import/no-named-as-default': 'off',
      'import/no-named-as-default-member': 'off',
      'import/no-unresolved': 'off',
      'import/extensions': 'off',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['src/client/**/*.ts', 'src/server/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  prettier,
);
