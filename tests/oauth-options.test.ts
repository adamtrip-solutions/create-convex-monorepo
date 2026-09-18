import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeOptions } from '../src/generator/options.js';
import { parseWorkspaceConfig } from '../src/workspace/project.js';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  select: vi.fn(),
  multiselect: vi.fn(),
  confirm: vi.fn(),
  text: vi.fn(),
  intro: vi.fn(),
}));
vi.mock('../src/generator/index.js', () => ({
  generateProject: mocks.generate,
}));
vi.mock('@clack/prompts', () => ({
  ...mocks,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
import { parseCommand, runCreate } from '../src/commands/create.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'process',
    Object.defineProperties(Object.create(process), {
      stdin: { value: { isTTY: true } },
      stdout: { value: { isTTY: true } },
    }),
  );
  mocks.multiselect.mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OAuth options', () => {
  it('parses, deduplicates and orders the comma list', () => {
    const parsed = parseCommand([
      '--auth',
      'convex-auth',
      '--oauth',
      'google, github,github',
    ]);
    expect(normalizeOptions(parsed.raw).oauth).toEqual(['github', 'google']);
  });
  it.each(['none', 'clerk', 'workos'])(
    'rejects OAuth with %s auth including an empty explicit value',
    (auth) => {
      for (const oauth of ['github', '', []])
        expect(() => normalizeOptions({ auth, oauth })).toThrow(
          '--oauth requires',
        );
    },
  );
  it.each(['facebook', 'github,unknown', 'github,', ''])(
    'rejects unsupported list %s',
    (oauth) => {
      expect(() => normalizeOptions({ auth: 'convex-auth', oauth })).toThrow(
        'Unknown OAuth provider',
      );
    },
  );
  it('omits OAuth when no providers are selected', () => {
    expect(normalizeOptions({ auth: 'convex-auth' })).not.toHaveProperty(
      'oauth',
    );
    expect(
      normalizeOptions({ auth: 'convex-auth', oauth: [] }),
    ).not.toHaveProperty('oauth');
  });
  it.each([{ selected: [] }, { selected: ['google'] }])(
    'prompts after selecting Convex Auth with selection %j',
    async ({ selected }) => {
      mocks.select
        .mockResolvedValueOnce('convex-auth')
        .mockResolvedValueOnce('none');
      mocks.multiselect.mockResolvedValueOnce(selected);
      await runCreate(
        [
          'sample',
          '--apps',
          'vite',
          '--package-manager',
          'pnpm',
          '--no-git',
          '--no-install',
        ],
        '1.0.0',
      );
      expect(mocks.multiselect).toHaveBeenCalledWith({
        message: 'OAuth providers?',
        options: [
          { value: 'github', label: 'GitHub' },
          { value: 'google', label: 'Google' },
        ],
        initialValues: [],
        required: false,
      });
      expect(mocks.select.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.multiselect.mock.invocationCallOrder[0]!,
      );
      expect(mocks.multiselect.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.select.mock.invocationCallOrder[1]!,
      );
      const options = mocks.generate.mock.calls[0]![0];
      if (selected.length) expect(options.oauth).toEqual(selected);
      else expect(options).not.toHaveProperty('oauth');
    },
  );
  it('does not prompt for explicit OAuth', async () => {
    await runCreate(
      [
        'sample',
        '--apps',
        'vite',
        '--package-manager',
        'pnpm',
        '--auth',
        'convex-auth',
        '--oauth',
        'google',
        '--example',
        'none',
        '--no-git',
        '--no-install',
      ],
      '1.0.0',
    );
    expect(mocks.multiselect).not.toHaveBeenCalled();
    expect(mocks.generate.mock.calls[0]![0].oauth).toEqual(['google']);
  });
  it('cancels the provider prompt before generation', async () => {
    mocks.multiselect.mockResolvedValueOnce(Symbol('cancel'));
    await expect(
      runCreate(
        [
          'sample',
          '--apps',
          'vite',
          '--package-manager',
          'pnpm',
          '--auth',
          'convex-auth',
          '--no-git',
          '--no-install',
        ],
        '1.0.0',
      ),
    ).rejects.toThrow('cancelled');
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});

const metadata = {
  version: 1,
  generator: '1.0.0',
  name: 'sample',
  packageManager: 'pnpm',
  monorepo: 'turbo',
  apps: [{ name: 'web', framework: 'vite' }],
  auth: 'convex-auth',
  example: 'none',
};
it('loads OAuth in version 1 metadata', () => {
  expect(
    parseWorkspaceConfig({ ...metadata, oauth: ['github', 'google'] }),
  ).toMatchObject({ version: 1, oauth: ['github', 'google'] });
  expect(parseWorkspaceConfig(metadata)).not.toHaveProperty('oauth');
});
it.each(['github', [1], ['unknown']])(
  'rejects invalid OAuth metadata %j',
  (oauth) => {
    expect(() => parseWorkspaceConfig({ ...metadata, oauth })).toThrow();
  },
);
it.each(['clerk', 'workos'])('rejects OAuth metadata with %s auth', (auth) => {
  expect(() =>
    parseWorkspaceConfig({ ...metadata, auth, oauth: ['github'] }),
  ).toThrow('--oauth requires');
});
