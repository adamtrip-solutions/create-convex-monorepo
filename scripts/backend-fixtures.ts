import { fileURLToPath } from 'node:url';
import { mkdir, rm } from 'node:fs/promises';
import { generateProject } from '../src/generator/index.js';
const cwd = fileURLToPath(new URL('../tests/.generated/', import.meta.url));
await rm(cwd, { recursive: true, force: true });
await mkdir(cwd, { recursive: true });
for (const auth of ['none', 'clerk', 'convex-auth'] as const) {
  await generateProject({ name: auth, apps: 'vite', auth }, { cwd });
}
