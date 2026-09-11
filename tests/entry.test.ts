import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  workspace: vi.fn(),
  select: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  select: mocks.select,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
vi.mock('../src/commands/create.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/commands/create.js')>()),
  runCreate: mocks.create,
}));
vi.mock('../src/commands/workspace.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/commands/workspace.js')>()),
  runWorkspace: mocks.workspace,
}));
import { runEntry } from '../src/commands/entry.js';
import { parseWorkspaceCommand } from '../src/commands/workspace.js';

let directory: string;
const metadata = {
  version: 1,
  generator: '0.3.0',
  name: 'test-workspace',
  packageManager: 'pnpm',
  monorepo: 'turbo',
  apps: [{ name: 'web', framework: 'next' }],
  auth: 'none',
  example: 'none',
};
async function workspace() {
  await writeFile(
    join(directory, 'convex-monorepo.json'),
    JSON.stringify(metadata),
  );
}
function terminal(enabled: boolean) {
  process.stdin.isTTY = enabled;
  process.stdout.isTTY = enabled;
}
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'ccm-entry-'));
  vi.stubGlobal(
    'process',
    Object.defineProperties(Object.create(process), {
      stdin: { value: { isTTY: false } },
      stdout: { value: { isTTY: false } },
      cwd: { value: () => directory, configurable: true },
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.workspace.mockImplementation(async (args: string[]) => {
    parseWorkspaceCommand(args);
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

describe('create binary dispatch', () => {
  it.each([
    ['add', 'app', 'admin', '--framework', 'vite', '--dry-run'],
    ['add', 'auth', 'clerk', '--no-install'],
    ['doctor', '--json'],
    ['env', 'sync', '--app', 'web'],
    ['upgrade', '--check', '--json'],
  ])(
    'routes management command %j without creating a project',
    async (...args) => {
      const controller = new AbortController();
      await runEntry(args, '0.3.0', controller.signal);
      expect(mocks.workspace).toHaveBeenCalledExactlyOnceWith(
        args,
        '0.3.0',
        controller.signal,
      );
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['doctor', '--force'],
    ['env', 'sync', '--install'],
    ['upgrade'],
    ['add', 'auth', 'workos'],
    ['--help', '--unknown'],
  ])('does not bypass argument validation for %j', async (...args) => {
    await expect(runEntry(args, '0.3.0')).rejects.toThrow();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([[], ['my-project', '--apps', 'next,expo', '--no-install']])(
    'preserves creation outside a workspace for %j',
    async (...args) => {
      await runEntry(args, '0.3.0');
      expect(mocks.create).toHaveBeenCalledExactlyOnceWith(
        args,
        '0.3.0',
        undefined,
      );
      expect(mocks.workspace).not.toHaveBeenCalled();
    },
  );

  it.each(['add', 'doctor', 'env', 'upgrade', 'create', 'help'])(
    'allows explicit creation of the reserved name %s',
    async (name) => {
      await workspace();
      await runEntry(['create', name, '--no-install'], '0.3.0');
      expect(mocks.create).toHaveBeenCalledExactlyOnceWith(
        [name, '--no-install'],
        '0.3.0',
        undefined,
      );
      expect(mocks.workspace).not.toHaveBeenCalled();
    },
  );

  it.each([['--help'], ['-h'], ['--version'], ['-v']])(
    'serves help/version even with malformed metadata %j',
    async (...args) => {
      await writeFile(join(directory, 'convex-monorepo.json'), '{');
      await runEntry(args, '0.3.0');
      expect(console.log).toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );

  it('includes both creation and management in top-level help', async () => {
    await runEntry(['--help'], '0.3.0');
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).toContain('create <project-name>');
    expect(output).toContain('npx create-convex-monorepo@latest <command>');
    expect(output).toContain('env sync');
  });
});

describe('workspace auto-detection', () => {
  it('prints management help without creating files in a noninteractive workspace', async () => {
    await workspace();
    const before = await readdir(directory);
    await runEntry([], '0.3.0');
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(
      'Existing workspace: test-workspace',
    );
    expect(await readdir(directory)).toEqual(before);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('detects metadata from an application subdirectory', async () => {
    await workspace();
    const nested = join(directory, 'apps', 'web', 'src');
    await mkdir(nested, { recursive: true });
    Object.defineProperty(process, 'cwd', { value: () => nested });
    await runEntry([], '0.3.0');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Existing workspace: test-workspace'),
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ['app', ['add', 'app']],
    ['auth', ['add', 'auth', 'clerk']],
    ['doctor', ['doctor']],
    ['env', ['env', 'sync']],
    ['upgrade', ['upgrade', '--check']],
  ])(
    'offers and dispatches the %s action interactively',
    async (action, args) => {
      await workspace();
      terminal(true);
      mocks.select.mockResolvedValueOnce(action);
      await runEntry([], '0.3.0');
      expect(mocks.select).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.arrayContaining([
            { value: 'app', label: expect.any(String) },
            { value: 'auth', label: expect.any(String) },
            { value: 'doctor', label: expect.any(String) },
            { value: 'env', label: expect.any(String) },
            { value: 'upgrade', label: expect.any(String) },
          ]),
        }),
      );
      expect(mocks.workspace).toHaveBeenCalledExactlyOnceWith(
        args,
        '0.3.0',
        undefined,
      );
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it.each([['--yes'], ['--apps', 'next'], ['--no-install']])(
    'rejects creation options without an explicit project name in a workspace %j',
    async (...args) => {
      await workspace();
      await expect(runEntry(args, '0.3.0')).rejects.toThrow(
        'existing Convex monorepo',
      );
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.workspace).not.toHaveBeenCalled();
    },
  );

  it.each(['{', JSON.stringify({ ...metadata, version: 99 })])(
    'fails on invalid metadata instead of offering creation',
    async (contents) => {
      await writeFile(join(directory, 'convex-monorepo.json'), contents);
      await expect(runEntry([], '0.3.0')).rejects.toThrow(/JSON|version/);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );

  it('rejects non-file metadata', async () => {
    await mkdir(join(directory, 'convex-monorepo.json'));
    await expect(runEntry([], '0.3.0')).rejects.toThrow('regular file');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('cancels the menu without running any command', async () => {
    await workspace();
    terminal(true);
    mocks.select.mockResolvedValueOnce(Symbol('cancel'));
    await expect(runEntry([], '0.3.0')).rejects.toThrow('cancelled');
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not start the menu after interruption', async () => {
    await workspace();
    terminal(true);
    const controller = new AbortController();
    controller.abort(new Error('Interrupted'));
    await expect(runEntry([], '0.3.0', controller.signal)).rejects.toThrow(
      'Interrupted',
    );
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
