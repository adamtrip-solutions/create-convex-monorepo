import type {
  AppSpec,
  GeneratorContext,
  PackageManifest,
} from '../../generator/types.js';
import { versions } from '../versions.js';

export function manifest(
  context: GeneratorContext,
  app: AppSpec,
): PackageManifest {
  return {
    name: `@${context.scope}/${app.name}`,
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .' },
    dependencies: {
      [`@${context.scope}/backend`]: 'workspace:*',
      convex: versions.convex,
      react: versions.react,
    },
    devDependencies: {
      [`@${context.scope}/typescript-config`]: 'workspace:*',
      [`@${context.scope}/eslint-config`]: 'workspace:*',
      typescript: versions.typescript,
      '@types/react': '19.2.18',
      eslint: versions.eslint,
    },
  };
}

export async function common(
  context: GeneratorContext,
  app: AppSpec,
  env: string,
): Promise<void> {
  const dir = `apps/${app.name}`;
  await context.write(
    `${dir}/eslint.config.js`,
    `import config from '@${context.scope}/eslint-config';\nexport default config;\n`,
  );
  await context.write(
    `${dir}/.env.example`,
    `# Copy to .env.local, then copy only the public deployment URL from packages/backend/.env.local.\n${env}=\n`,
  );
  await context.write(
    `${dir}/src/convex-api.type-test.ts`,
    `import { api } from '@${context.scope}/backend/api';
import type { Doc, Id } from '@${context.scope}/backend/dataModel';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export type ApiIsTyped = Assert<Equal<IsAny<typeof api>, false>>;
export type ListIsTyped = Assert<Equal<IsAny<typeof api.messages.list>, false>>;
export type ListResult = Assert<Equal<FunctionReturnType<typeof api.messages.list>, Doc<'messages'>[]>>;
export type SendArgs = Assert<Equal<FunctionArgs<typeof api.messages.send>, { body: string }>>;
export type SendResult = Assert<Equal<FunctionReturnType<typeof api.messages.send>, Id<'messages'>>>;
// These intentional negative tests fail if API references widen to arbitrary keys.
// @ts-expect-error No such backend module.
export type MissingModule = typeof api.notAModule;
// @ts-expect-error No such backend function.
export type MissingFunction = typeof api.messages.notAFunction;
`,
  );
}

export async function webMessages(
  context: GeneratorContext,
  app: AppSpec,
): Promise<void> {
  await context.write(
    `apps/${app.name}/src/messages.tsx`,
    `'use client';

import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@${context.scope}/backend/api';

export function Messages() {
  const messages = useQuery(api.messages.list, {});
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!body.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      await send({ body: body.trim() });
      setBody('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the message.');
    } finally {
      setPending(false);
    }
  }
  return <section aria-label="Messages">
    <h1>Messages</h1>
    {messages === undefined ? <p>Loading messages…</p> : messages.length === 0 ? <p>No messages yet.</p> :
      <ul>{messages.map((message) => <li key={message._id}>{message.body}</li>)}</ul>}
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label htmlFor="message">Message</label>{' '}
      <input id="message" value={body} onChange={(event) => setBody(event.target.value)} maxLength={1000} disabled={pending} />{' '}
      <button type="submit" disabled={pending || !body.trim()}>{pending ? 'Sending…' : 'Send'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </section>;
}
`,
  );
}

export function webTsconfig(context: GeneratorContext) {
  return {
    extends: `@${context.scope}/typescript-config/base.json`,
    compilerOptions: {
      target: 'ES2022',
      lib: ['DOM', 'DOM.Iterable', 'ES2022'],
      jsx: 'react-jsx',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      noEmit: true,
      strict: true,
    },
    include: ['src', '*.ts'],
    exclude: ['node_modules', 'dist'],
  };
}

export function port(context: GeneratorContext, app: AppSpec): number {
  return (
    3000 + context.options.apps.findIndex((entry) => entry.name === app.name)
  );
}
