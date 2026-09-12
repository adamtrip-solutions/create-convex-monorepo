import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  apply: vi.fn(),
  app: vi.fn(),
  package: vi.fn(),
  auth: vi.fn(),
  env: vi.fn(),
  doctor: vi.fn(),
  upgrade: vi.fn(),
  planUpgrade: vi.fn(),
  install: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  select: mocks.select,
  text: mocks.text,
  confirm: mocks.confirm,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
vi.mock('../src/workspace/project.js', () => ({ loadWorkspace: mocks.load }));
vi.mock('../src/workspace/changes.js', () => ({ applyPlan: mocks.apply }));
vi.mock('../src/workspace/add.js', () => ({
  planAddApp: mocks.app,
  planAddPackage: mocks.package,
  planAddAuth: mocks.auth,
}));
vi.mock('../src/workspace/env.js', () => ({ planEnvSync: mocks.env }));
vi.mock('../src/workspace/doctor.js', () => ({ doctor: mocks.doctor }));
vi.mock('../src/workspace/upgrade.js', () => ({
  checkUpgrade: mocks.upgrade,
  planUpgrade: mocks.planUpgrade,
}));
vi.mock('../src/package-manager/index.js', () => ({
  pnpm: { install: mocks.install },
}));
import {
  parseWorkspaceCommand,
  runWorkspace,
} from '../src/commands/workspace.js';

const workspace = { root: '/workspace', config: { example: 'messages' } };
const plan = {
  root: '/workspace',
  changes: [
    {
      path: 'apps/admin/.env.local',
      before: null,
      after: 'SECRET=must-not-print',
    },
  ],
  notes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'process',
    Object.defineProperties(Object.create(process), {
      stdin: { value: { isTTY: false } },
      stdout: { value: { isTTY: false } },
      exitCode: { value: undefined, writable: true },
    }),
  );
  mocks.load.mockResolvedValue(workspace);
  mocks.app.mockResolvedValue(plan);
  mocks.package.mockResolvedValue(plan);
  mocks.auth.mockResolvedValue(plan);
  mocks.env.mockResolvedValue(plan);
  mocks.planUpgrade.mockResolvedValue(plan);
  mocks.apply.mockResolvedValue(undefined);
  mocks.install.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('workspace argument parsing', () => {
  it('keeps Convex Auth installation unsupported and names Clerk', () => {
    expect(() => parseWorkspaceCommand(['add', 'auth', 'convex-auth'])).toThrow(
      'Only Clerk authentication is supported. Use add auth clerk.',
    );
  });

  it.each([
    ['doctor', '--dry-run'],
    ['doctor', '--app', 'web'],
    ['env', 'sync', '--install'],
    ['add', 'auth', '--framework', 'vite'],
    ['add', 'package', 'shared', '--framework', 'vite'],
    ['add', 'package', 'shared', '--example', 'none'],
    ['upgrade', '--check', '--yes'],
    ['--force'],
    ['add', 'app', 'web', '--framework', 'vite', '--install', '--no-install'],
    ['add', 'app', 'web', '--framework', 'svelte'],
    ['add', 'app', 'web', '--example', 'chat'],
    ['add', 'auth', 'other'],
    ['doctor', 'extra'],
    ['add', 'other'],
    ['upgrade', '--check', '--dry-run'],
    ['upgrade', '--check', '--install'],
    ['upgrade', '--check', '--no-install'],
    ['upgrade', '--json'],
  ])('rejects invalid arguments %j', (...args) => {
    expect(() => parseWorkspaceCommand(args)).toThrow();
  });

  it.each([
    [],
    ['--dry-run'],
    ['--install'],
    ['--yes'],
    ['-y'],
    ['--yes', '--no-install'],
  ])('accepts upgrade options %j', (...flags) => {
    expect(parseWorkspaceCommand(['upgrade', ...flags])).toMatchObject({
      command: 'upgrade',
      check: false,
    });
  });

  it('parses an explicit application and honors no-install with yes', () => {
    expect(
      parseWorkspaceCommand([
        'add',
        'app',
        'admin',
        '--framework',
        'vite',
        '--example',
        'none',
        '--dry-run',
        '--yes',
        '--no-install',
      ]),
    ).toMatchObject({
      command: 'add-app',
      name: 'admin',
      framework: 'vite',
      example: 'none',
      dryRun: true,
      yes: true,
      install: false,
    });
  });
});

describe('workspace command routing', () => {
  it.each(['--install', '--no-install'])(
    'parses package add flags with %s',
    (flag) => {
      expect(
        parseWorkspaceCommand([
          'add',
          'package',
          'shared',
          flag,
          '--yes',
          '--dry-run',
        ]),
      ).toMatchObject({
        command: 'add-package',
        name: 'shared',
        install: flag === '--install',
        yes: true,
        dryRun: true,
      });
    },
  );
  it('routes package addition and installs after applying', async () => {
    await runWorkspace(['add', 'package', 'shared', '--install'], '1.2.3');
    expect(mocks.package).toHaveBeenCalledExactlyOnceWith(workspace, {
      name: 'shared',
    });
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(plan, {});
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith(
      '/workspace',
      undefined,
    );
    expect(mocks.apply.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.install.mock.invocationCallOrder[0]!,
    );
  });
  it('keeps package dry runs from installing', async () => {
    await runWorkspace(
      ['add', 'package', 'shared', '--dry-run', '--install'],
      '1.2.3',
    );
    expect(mocks.package).toHaveBeenCalledWith(workspace, { name: 'shared' });
    expect(mocks.apply).toHaveBeenCalledWith(plan, { dryRun: true });
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('offers shared packages and validates the name prompt', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    mocks.select.mockResolvedValueOnce('add-package');
    mocks.text.mockResolvedValueOnce('shared');
    await runWorkspace(['add', '--no-install'], '1.2.3');
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          { value: 'add-package', label: 'Shared package' },
        ]),
      }),
    );
    const prompt = mocks.text.mock.calls[0]![0];
    expect(prompt.message).toBe('Package name?');
    expect(prompt.validate('shared')).toBeUndefined();
    expect(prompt.validate('../bad')).toContain('lowercase');
    expect(mocks.package).toHaveBeenCalledWith(workspace, { name: 'shared' });
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('cancels package naming without planning or writing', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    mocks.text.mockResolvedValueOnce(Symbol('cancel'));
    await expect(runWorkspace(['add', 'package'], '1.2.3')).rejects.toThrow(
      'cancelled',
    );
    expect(mocks.package).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it.each([[], ['--help'], ['--version'], ['upgrade', '--help']])(
    'handles help and version without loading a workspace %j',
    async (...args) => {
      await runWorkspace(args, '1.2.3');
      expect(mocks.load).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalled();
    },
  );
  it.each([
    ['add'],
    ['add', '--yes'],
    ['add', 'app'],
    ['add', 'package'],
    ['add', 'app', 'admin'],
    ['add', 'app', '--framework', 'vite'],
  ])('requires explicit app inputs without a terminal %j', async (...args) => {
    await expect(runWorkspace(args, '1.2.3')).rejects.toThrow(
      /prompts|framework/,
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('prints paths without file contents and skips mutation and install on dry run', async () => {
    await runWorkspace(
      ['add', 'app', 'admin', '--framework', 'vite', '--dry-run', '--install'],
      '1.2.3',
    );
    expect(mocks.app).toHaveBeenCalledWith(workspace, {
      name: 'admin',
      framework: 'vite',
    });
    expect(mocks.apply).toHaveBeenCalledWith(plan, { dryRun: true });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(
      'apps/admin/.env.local',
    );
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain(
      'must-not-print',
    );
  });
  it('applies app changes without installation by default', async () => {
    await runWorkspace(
      ['add', 'app', 'admin', '--framework', 'vite', '--example', 'none'],
      '1.2.3',
    );
    expect(mocks.app).toHaveBeenCalledWith(workspace, {
      name: 'admin',
      framework: 'vite',
      example: 'none',
    });
    expect(mocks.apply).toHaveBeenCalledWith(plan, {});
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it.each([['--install'], ['--yes']])(
    'installs after applying auth changes with %j',
    async (...flags) => {
      await runWorkspace(['add', 'auth', 'clerk', ...flags], '1.2.3');
      expect(mocks.auth).toHaveBeenCalledWith(workspace, 'clerk');
      expect(mocks.apply).toHaveBeenCalledWith(plan, {});
      expect(mocks.install).toHaveBeenCalledWith('/workspace', undefined);
      expect(mocks.apply.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.install.mock.invocationCallOrder[0]!,
      );
    },
  );
  it('does not install with yes and no-install', async () => {
    await runWorkspace(['add', 'auth', '--yes', '--no-install'], '1.2.3');
    expect(mocks.apply).toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('does not bypass conflicts with yes', async () => {
    mocks.apply.mockRejectedValueOnce(
      new Error('Conflict: apps/web/package.json changed.'),
    );
    await expect(
      runWorkspace(['add', 'auth', '--yes'], '1.2.3'),
    ).rejects.toThrow('Conflict');
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('routes targeted env sync without exposing values', async () => {
    await runWorkspace(['env', 'sync', '--app', 'web', '--dry-run'], '1.2.3');
    expect(mocks.env).toHaveBeenCalledWith(workspace, { app: 'web' });
    expect(mocks.apply).toHaveBeenCalledWith(plan, { dryRun: true });
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it.each(['warning', 'error'])(
    'sets doctor exit status for %s issues',
    async (severity) => {
      const result = {
        issues: [
          { code: 'test', severity, message: 'Test issue', fix: 'Test fix' },
        ],
        checks: [],
      };
      mocks.doctor.mockResolvedValue(result);
      await runWorkspace(['doctor', '--json'], '1.2.3');
      expect(console.log).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
      expect(process.exitCode).toBe(severity === 'error' ? 1 : undefined);
      expect(mocks.apply).not.toHaveBeenCalled();
    },
  );
  it('reports an available upgrade without failing or mutating', async () => {
    const result = {
      cliVersion: '1.2.3',
      projectGenerator: '1.0.0',
      latestStable: '2.0.0',
      updateAvailable: true,
      projectBehind: true,
      baseline: {},
      registry: 'https://registry.npmjs.org',
    };
    mocks.upgrade.mockResolvedValue(result);
    await runWorkspace(['upgrade', '--check', '--json'], '1.2.3');
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
    expect(process.exitCode).toBeUndefined();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('propagates registry errors', async () => {
    mocks.upgrade.mockRejectedValueOnce(new Error('Registry unavailable'));
    await expect(runWorkspace(['upgrade', '--check'], '1.2.3')).rejects.toThrow(
      'Registry unavailable',
    );
  });
  it('prompts for an app and optional installation in a terminal', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    mocks.select
      .mockResolvedValueOnce('add-app')
      .mockResolvedValueOnce('vite')
      .mockResolvedValueOnce('none');
    mocks.text.mockResolvedValueOnce('admin');
    mocks.confirm.mockResolvedValueOnce(true);
    await runWorkspace(['add'], '1.2.3');
    expect(mocks.app).toHaveBeenCalledWith(workspace, {
      name: 'admin',
      framework: 'vite',
      example: 'none',
    });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.app.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.confirm.mock.invocationCallOrder[0]!,
    );
    expect(mocks.confirm.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.apply.mock.invocationCallOrder[0]!,
    );
    expect(mocks.select).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: 'Starter content?',
        initialValue: 'messages',
      }),
    );
  });
  it('does not prompt for installation during an interactive dry run', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    await runWorkspace(['add', 'auth', '--dry-run'], '1.2.3');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.apply).toHaveBeenCalledWith(plan, { dryRun: true });
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('cancels before writing when the install prompt is cancelled', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    mocks.confirm.mockResolvedValueOnce(Symbol('cancel'));
    await expect(runWorkspace(['add', 'auth'], '1.2.3')).rejects.toThrow(
      'cancelled',
    );
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('validates dry runs and propagates preflight conflicts', async () => {
    const controller = new AbortController();
    mocks.apply.mockRejectedValueOnce(new Error('Conflict: stale file'));
    await expect(
      runWorkspace(['env', 'sync', '--dry-run'], '1.2.3', controller.signal),
    ).rejects.toThrow('Conflict');
    expect(mocks.apply).toHaveBeenCalledWith(plan, {
      dryRun: true,
      signal: controller.signal,
    });
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('explains how to retry installation after files were applied', async () => {
    const failure = new Error('Network unavailable');
    mocks.install.mockRejectedValueOnce(failure);
    const result = runWorkspace(['add', 'auth', '--install'], '1.2.3');
    await expect(result).rejects.toThrow('Workspace files were updated');
    await expect(result).rejects.toThrow('Run pnpm install');
    await expect(result).rejects.toHaveProperty('cause', failure);
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(plan, {});
  });
  it('skips the starter prompt when example is explicit', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    await runWorkspace(
      [
        'add',
        'app',
        'admin',
        '--framework',
        'vite',
        '--example',
        'none',
        '--dry-run',
      ],
      '1.2.3',
    );
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.app).toHaveBeenCalledWith(workspace, {
      name: 'admin',
      framework: 'vite',
      example: 'none',
    });
  });
  it('does no work after cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Interrupted'));
    await expect(
      runWorkspace(['env', 'sync'], '1.2.3', controller.signal),
    ).rejects.toThrow('Interrupted');
    expect(mocks.load).not.toHaveBeenCalled();
  });
});

describe('upgrade mutations', () => {
  it.each([['--install'], ['--yes'], ['-y']])(
    'applies and installs with %j',
    async (...flags) => {
      await runWorkspace(['upgrade', ...flags], '1.2.3');
      expect(mocks.planUpgrade).toHaveBeenCalledExactlyOnceWith(workspace);
      expect(mocks.upgrade).not.toHaveBeenCalled();
      expect(mocks.apply).toHaveBeenCalledWith(plan, {});
      expect(mocks.install).toHaveBeenCalledWith('/workspace', undefined);
      expect(mocks.apply.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.install.mock.invocationCallOrder[0]!,
      );
    },
  );
  it.each([[], ['--no-install'], ['--yes', '--no-install']])(
    'does not install with %j',
    async (...flags) => {
      await runWorkspace(['upgrade', ...flags], '1.2.3');
      expect(mocks.apply).toHaveBeenCalledWith(plan, {});
      expect(mocks.install).not.toHaveBeenCalled();
    },
  );
  it('preflights dry runs without printing file contents or installing', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    await runWorkspace(['upgrade', '--dry-run', '--install'], '1.2.3');
    expect(mocks.apply).toHaveBeenCalledWith(plan, { dryRun: true });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).toContain('create apps/admin/.env.local');
    expect(output).not.toContain('must-not-print');
  });
  it('prints a no-op and does not install', async () => {
    mocks.planUpgrade.mockResolvedValueOnce({ ...plan, changes: [] });
    await runWorkspace(['upgrade', '--install'], '1.2.3');
    expect(console.log).toHaveBeenCalledWith('No changes needed.');
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'honors the interactive install choice %s',
    async (install) => {
      process.stdin.isTTY = true;
      process.stdout.isTTY = true;
      mocks.confirm.mockResolvedValueOnce(install);
      await runWorkspace(['upgrade'], '1.2.3');
      expect(mocks.confirm).toHaveBeenCalledOnce();
      expect(mocks.apply).toHaveBeenCalledWith(plan, {});
      expect(mocks.install).toHaveBeenCalledTimes(install ? 1 : 0);
    },
  );
  it('cancels the install prompt without applying', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    mocks.confirm.mockResolvedValueOnce(Symbol('cancel'));
    await expect(runWorkspace(['upgrade'], '1.2.3')).rejects.toThrow(
      'cancelled',
    );
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('does not bypass planner conflicts with yes', async () => {
    mocks.planUpgrade.mockRejectedValueOnce(
      new Error('Conflicting dependency pins'),
    );
    await expect(runWorkspace(['upgrade', '--yes'], '1.2.3')).rejects.toThrow(
      'Conflicting',
    );
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });
});
