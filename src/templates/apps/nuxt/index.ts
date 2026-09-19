import type { AppTemplate } from '../../../generator/types.js';
import { versions as v } from '../../versions.js';
import { common, manifest, port } from '../shared.js';

export const nuxtTemplate: AppTemplate = {
  id: 'nuxt',
  label: 'Nuxt',
  async generate(ctx, app) {
    const dir = `apps/${app.name}`;
    const pkg = manifest(ctx, app);
    pkg.scripts = {
      dev: `nuxt dev --dotenv .env.local --port ${port(ctx, app)}`,
      build: 'nuxt build --dotenv .env.local',
      preview: 'nuxt preview --dotenv .env.local',
      postinstall: 'nuxt prepare',
      typecheck:
        'nuxt prepare && vue-tsc --noEmit -p .nuxt/tsconfig.json && vue-tsc --noEmit -p .nuxt/tsconfig.server.json',
      lint: 'eslint .',
    };
    pkg.dependencies = {
      ...pkg.dependencies,
      nuxt: v.nuxt,
      vue: v.vue,
      'convex-vue': v.convexVue,
    };
    pkg.devDependencies = {
      ...pkg.devDependencies,
      'vue-tsc': v.vueTsc,
      'eslint-plugin-vue': v.eslintPluginVue,
      'vue-eslint-parser': v.vueEslintParser,
      'typescript-eslint': v.typescriptEslint,
    };
    await ctx.json(`${dir}/package.json`, pkg);
    await common(
      ctx,
      app,
      'NUXT_PUBLIC_CONVEX_URL',
      [],
      `import config from '@${ctx.scope}/eslint-config';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import tseslint from 'typescript-eslint';

export default [
  ...config,
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: { parser: vueParser, parserOptions: { parser: tseslint.parser } },
    rules: { 'vue/multi-word-component-names': 'off' },
  },
  { ignores: ['.nuxt/**', '.output/**'] },
];
`,
    );
    await ctx.write(
      `${dir}/nuxt.config.ts`,
      `import { defineNuxtConfig } from 'nuxt/config';

export default defineNuxtConfig({
  compatibilityDate: '2026-09-18',
  srcDir: 'src/',
  ssr: true,
  devtools: { enabled: false },
  runtimeConfig: { public: { convexUrl: '' } },
  typescript: { strict: true },
});
`,
    );
    await ctx.json(`${dir}/tsconfig.json`, {
      extends: './.nuxt/tsconfig.json',
      compilerOptions: { strict: true, noEmit: true },
    });
    await ctx.write(
      `${dir}/src/app.vue`,
      `<script setup lang="ts">
import Providers from './components/Providers.vue';
import AuthControls from './components/AuthControls.vue';
${ctx.options.example === 'messages' ? "import Messages from './components/Messages.vue';" : ''}
</script>

<template>
  <main>
    ${ctx.options.example === 'none' ? `<h1>${app.name}</h1>` : ''}
    <Providers>
      <AuthControls />
      ${ctx.options.example === 'messages' ? '<Messages />' : ''}
    </Providers>
  </main>
</template>
`,
    );
    if (ctx.options.example === 'none') return;
    await ctx.write(
      `${dir}/src/components/Messages.vue`,
      `<script setup lang="ts">
import { ref } from 'vue';
import { useConvexQuery, useConvexMutation } from 'convex-vue';
import { api } from '@${ctx.scope}/backend/api';

const { data: messages, error: queryError } = useConvexQuery(api.messages.list, {});
const { mutate: send } = useConvexMutation(api.messages.send);
const body = ref('');
const pending = ref(false);
const error = ref<string | null>(null);
async function submit() {
  if (!body.value.trim() || pending.value) return;
  pending.value = true;
  error.value = null;
  try {
    await send({ body: body.value.trim() });
    body.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not send the message.';
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <section aria-label="Messages">
    <h1>Messages</h1>
    <p v-if="queryError" role="alert">{{ queryError.message }}</p>
    <p v-else-if="messages === undefined">Loading messages…</p>
    <p v-else-if="messages.length === 0">No messages yet.</p>
    <ul v-else><li v-for="message in messages" :key="message._id">{{ message.body }}</li></ul>
    <form @submit.prevent="submit">
      <label for="message">Message</label>
      <input id="message" v-model="body" maxlength="1000" :disabled="pending" />
      <button type="submit" :disabled="pending || !body.trim()">{{ pending ? 'Sending…' : 'Send' }}</button>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
`,
    );
  },
};
