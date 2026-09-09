import tseslint from 'typescript-eslint';
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'assets/**',
      'node_modules/**',
      'coverage/**',
      'tests/.generated/**',
      '.e2e/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,ts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
