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
vi.mock('../src/generator/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/generator/index.js')>()),
  generateProject: mocks.generate,
}));
import { runCreate } from '../src/commands/create.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('offers React Router v7 in the interactive framework prompt and uses its selection', async () => {
  vi.stubGlobal(
    'process',
    Object.defineProperties(Object.create(process), {
      stdin: { value: { isTTY: true } },
      stdout: { value: { isTTY: true } },
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.select.mockResolvedValueOnce('react-router');
  mocks.text.mockResolvedValueOnce('portal');
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
        { value: 'react-router', label: 'React Router v7' },
      ]),
    }),
  );
  expect(mocks.generate).toHaveBeenCalledWith(
    expect.objectContaining({
      apps: [{ name: 'portal', framework: 'react-router' }],
    }),
    expect.anything(),
  );
});
