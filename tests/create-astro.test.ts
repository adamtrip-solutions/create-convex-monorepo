import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  generate: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  select: mocks.select,
  text: mocks.text,
  confirm: mocks.confirm,
  intro: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
vi.mock('../src/generator/index.js', () => ({
  generateProject: mocks.generate,
}));
import { runCreate } from '../src/commands/create.js';

const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;
afterEach(() => {
  process.stdin.isTTY = stdinTTY;
  process.stdout.isTTY = stdoutTTY;
  vi.restoreAllMocks();
});

it('offers Astro in the create prompt and generates the selected named app', async () => {
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.select.mockResolvedValueOnce('astro');
  mocks.text.mockResolvedValueOnce('island');
  mocks.confirm.mockResolvedValueOnce(false);
  await runCreate(
    [
      'sample',
      '--package-manager',
      'pnpm',
      '--auth',
      'none',
      '--example',
      'none',
      '--no-install',
      '--no-git',
    ],
    '1.2.3',
  );
  expect(mocks.select).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'Application framework?',
      options: expect.arrayContaining([
        { value: 'astro', label: 'Astro + React island' },
      ]),
    }),
  );
  expect(mocks.generate).toHaveBeenCalledWith(
    expect.objectContaining({
      apps: [{ name: 'island', framework: 'astro' }],
      auth: 'none',
      example: 'none',
      install: false,
      git: false,
    }),
    expect.any(Object),
  );
});
