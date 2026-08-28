// @ts-check
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier/flat';

export default tseslint.config(
  // Mirrors .prettierignore, plus emitted JS.
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/lib/**',
      '**/build/**',
      '**/coverage/**',
      '.gnhf/**',
      '.claude/worktrees/**',
      '**/.turbo/**',
      '**/*.js',
      '**/*.d.ts',
    ],
  },

  // Type-aware linting for every hand-written TS file in the workspace.
  {
    files: ['packages/*/src/**/*.ts', 'examples/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Deliberate repo idiom: `async` marks a function as part of the awaited
      // middleware/handler contract even when a given branch has nothing to await.
      // Callers still await it, so the safety core (no-floating-promises,
      // no-misused-promises, await-thenable) keeps doing the real work.
      '@typescript-eslint/require-await': 'off',

      // Match tsconfig's noUnusedLocals/noUnusedParameters, which already treat
      // a leading underscore as "intentionally unused".
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // `expect(mock.someMethod).toHaveBeenCalledWith(...)` is the vitest idiom for
  // asserting on a spy; the method is never actually invoked unbound.
  {
    files: ['packages/*/src/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // Must stay last: turns off everything Prettier owns.
  eslintConfigPrettier,
);
