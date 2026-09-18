import { afterEach, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { runCreate } from '../src/commands/create.js';
import { generateProject } from '../src/generator/index.js';

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('../src/generator/index.js', () => ({ generateProject: vi.fn() }));
const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;
afterEach(() => {
  process.stdin.isTTY = stdinTTY;
  process.stdout.isTTY = stdoutTTY;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each(['none', 'messages'])(
  'offers SvelteKit in the create prompt for the %s starter',
  async (example) => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(prompts.select).mockResolvedValueOnce('sveltekit');
    vi.mocked(prompts.text).mockResolvedValueOnce('web');
    vi.mocked(prompts.confirm).mockResolvedValueOnce(false);
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
      '1.0.0',
    );
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Application framework?',
        options: expect.arrayContaining([
          { value: 'sveltekit', label: 'SvelteKit' },
        ]),
      }),
    );
    expect(generateProject).toHaveBeenCalledWith(
      expect.objectContaining({
        apps: [{ name: 'web', framework: 'sveltekit' }],
        auth: 'none',
        example,
      }),
      expect.any(Object),
    );
  },
);
