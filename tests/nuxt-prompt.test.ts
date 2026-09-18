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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(['messages', 'none'])(
  'offers Nuxt in the interactive framework prompt for %s',
  async (example) => {
    vi.stubGlobal(
      'process',
      Object.defineProperties(Object.create(process), {
        stdin: { value: { isTTY: true } },
        stdout: { value: { isTTY: true } },
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.select.mockResolvedValue('nuxt');
    mocks.text.mockResolvedValue('portal');
    mocks.confirm.mockResolvedValue(false);
    await runCreate(
      [
        'prompted',
        '--package-manager',
        'pnpm',
        '--auth',
        'none',
        '--example',
        example,
        '--no-install',
        '--no-git',
      ],
      '0.0.0',
    );
    expect(mocks.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Application framework?',
        options: expect.arrayContaining([{ value: 'nuxt', label: 'Nuxt' }]),
      }),
    );
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        apps: [{ name: 'portal', framework: 'nuxt' }],
        auth: 'none',
        example,
      }),
      expect.any(Object),
    );
  },
);
