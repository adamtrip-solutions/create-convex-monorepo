import type { AppTemplate } from '../../../generator/types.js';
import { formattingOptions } from '../../../generator/format.js';
import { versions as v } from '../../versions.js';
import { common, entryContent, manifest, port } from '../shared.js';

export const sveltekitTemplate: AppTemplate = {
  id: 'sveltekit',
  label: 'SvelteKit',
  async generate(context, app) {
    const dir = `apps/${app.name}`;
    const entry = entryContent(context, app, '..');
    const pkg = manifest(context, app);
    pkg.scripts = {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
      prepare: 'svelte-kit sync',
      typecheck: 'svelte-kit sync && svelte-check --tsconfig ./tsconfig.json',
      lint: 'eslint .',
    };
    pkg.dependencies = {
      ...pkg.dependencies,
      svelte: v.svelte,
      'convex-svelte': v.convexSvelte,
    };
    pkg.devDependencies = {
      ...pkg.devDependencies,
      '@sveltejs/kit': v.sveltekit,
      '@sveltejs/adapter-auto': v.svelteAdapterAuto,
      '@sveltejs/vite-plugin-svelte': v.viteSvelte,
      vite: v.vite,
      'svelte-check': v.svelteCheck,
      '@types/node': v.nodeTypes,
      'eslint-plugin-svelte': v.eslintSvelte,
      'typescript-eslint': v.typescriptEslint,
      'prettier-plugin-svelte': v.prettierSvelte,
    };
    await context.json(`${dir}/package.json`, pkg);
    // Package config also works when add app targets an older root Turbo config.
    await context.json(`${dir}/turbo.json`, {
      extends: ['//'],
      tasks: {
        dev: { passThroughEnv: ['PUBLIC_*'] },
        build: {
          inputs: ['$TURBO_DEFAULT$', '.env*'],
          outputs: ['.svelte-kit/**', 'build/**'],
          env: ['PUBLIC_*'],
        },
        typecheck: { env: ['PUBLIC_*'] },
      },
    });
    await context.json(`${dir}/tsconfig.json`, {
      extends: [
        `@${context.scope}/typescript-config/base.json`,
        './.svelte-kit/tsconfig.json',
      ],
      compilerOptions: {
        strict: true,
        allowJs: true,
        checkJs: true,
        types: ['node'],
        rewriteRelativeImportExtensions: true,
      },
    });
    await context.write(
      `${dir}/prettier.config.js`,
      `import { createRequire } from 'node:module';
export default {
  ...${JSON.stringify(formattingOptions)},
  plugins: [createRequire(import.meta.url).resolve('prettier-plugin-svelte')],
  overrides: [{ files: '*.svelte', options: { parser: 'svelte' } }],
};
`,
    );
    await context.write(`${dir}/.gitignore`, '.svelte-kit/\nbuild/\n');
    await context.write(
      `${dir}/svelte.config.js`,
      `import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
export default { preprocess: vitePreprocess(), kit: { adapter: adapter() } };
`,
    );
    await context.write(
      `${dir}/vite.config.ts`,
      `import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
export default defineConfig({ plugins: [sveltekit()], server: { port: ${port(context, app)}, strictPort: true } });
`,
    );
    await context.write(
      `${dir}/src/app.html`,
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <div style="display: contents">%sveltekit.body%</div>
  </body>
</html>
`,
    );
    await context.write(
      `${dir}/src/routes/+layout.svelte`,
      `<script lang="ts">
  import type { Snippet } from 'svelte';
  import Providers from '../Providers.svelte';
  let { children }: { children: Snippet } = $props();
</script>

<Providers>{@render children()}</Providers>
`,
    );
    await context.write(
      `${dir}/src/routes/+page.svelte`,
      `<script lang="ts">
  import AuthControls from '../AuthControls.svelte';
  ${entry.imports}
</script>

<svelte:head><title>${app.name}</title></svelte:head>
<main><AuthControls />${entry.content}</main>
`,
    );
    await common(context, app, 'PUBLIC_CONVEX_URL');
    if (context.options.example === 'messages') {
      await context.write(
        `${dir}/src/Messages.svelte`,
        `<script lang="ts">
  import { getConvexClient, useQuery } from 'convex-svelte';
  import { api } from '@${context.scope}/backend/api';
  const messages = useQuery(api.messages.list, () => ({}));
  const client = getConvexClient();
  let body = $state('');
  let pending = $state(false);
  let error = $state<string | null>(null);
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!body.trim() || pending) return;
    pending = true;
    error = null;
    try {
      await client.mutation(api.messages.send, { body: body.trim() });
      body = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not send the message.';
    } finally {
      pending = false;
    }
  }
</script>

<section aria-label="Messages">
  <h1>Messages</h1>
  {#if messages.isLoading}
    <p>Loading messages…</p>
  {:else if messages.error}
    <p role="alert">{messages.error.message}</p>
  {:else if messages.data.length === 0}
    <p>No messages yet.</p>
  {:else}
    <ul>{#each messages.data as message (message._id)}<li>{message.body}</li>{/each}</ul>
  {/if}
  <form onsubmit={submit}>
    <label for="message">Message</label>
    <input id="message" bind:value={body} maxlength={1000} disabled={pending} />
    <button type="submit" disabled={pending || !body.trim()}>{pending ? 'Sending…' : 'Send'}</button>
  </form>
  {#if error}<p role="alert">{error}</p>{/if}
</section>
`,
      );
    }
  },
};
