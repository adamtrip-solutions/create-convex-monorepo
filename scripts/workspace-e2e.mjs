process.env.CCM_WORKSPACE_COMMANDS = '1';
process.env.CCM_AUTH ??= 'clerk';
await import('./e2e.mjs');
