import tseslint from 'typescript-eslint';
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'assets/**/*',
      '!assets/setup/',
      '!assets/setup/*.mjs',
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
