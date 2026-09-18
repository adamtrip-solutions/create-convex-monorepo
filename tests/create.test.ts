import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), select: vi.fn() }));
vi.mock('../src/generator/index.js', () => ({
  generateProject: mocks.generate,
}));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  select: mocks.select,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
import { runCreate } from '../src/commands/create.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
it.each(['pnpm', 'bun'])(
  'offers both managers with pnpm default and uses selected %s',
  async (manager) => {
    const input = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const output = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mocks.select.mockResolvedValue(manager);
    try {
      await runCreate(
        [
          'sample',
          '--apps',
          'vite',
          '--auth',
          'none',
          '--example',
          'none',
          '--no-install',
          '--no-git',
          '--no-init-convex',
        ],
        '0.0.0',
      );
      expect(mocks.select).toHaveBeenCalledWith({
        message: 'Package manager?',
        initialValue: 'pnpm',
        options: [
          { value: 'pnpm', label: 'pnpm' },
          { value: 'bun', label: 'bun' },
        ],
      });
      expect(mocks.generate).toHaveBeenCalledWith(
        expect.objectContaining({ packageManager: manager }),
        expect.any(Object),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`${manager} install`),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(manager === 'bun' ? 'bun run dev' : 'pnpm dev'),
      );
    } finally {
      if (input) Object.defineProperty(process.stdin, 'isTTY', input);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (output) Object.defineProperty(process.stdout, 'isTTY', output);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  },
);
