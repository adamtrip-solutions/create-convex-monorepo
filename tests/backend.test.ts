import betterAuthTest from '@convex-dev/better-auth/test';
import betterAuthSchema from './.generated/better-auth/packages/backend/convex/schema';
import {
  api as betterAuthApi,
  components as betterAuthComponents,
} from './.generated/better-auth/packages/backend/convex/_generated/api';

import workosSchema from './.generated/workos/packages/backend/convex/schema';
import { api as workosApi } from './.generated/workos/packages/backend/convex/_generated/api';
import { convexTest } from 'convex-test';
import { expect, test } from 'vitest';
import noneSchema from './.generated/none/packages/backend/convex/schema';
import clerkSchema from './.generated/clerk/packages/backend/convex/schema';
import convexAuthSchema from './.generated/convex-auth/packages/backend/convex/schema';
import { api as convexAuthApi } from './.generated/convex-auth/packages/backend/convex/_generated/api';
import { api as publicApi } from './.generated/none/packages/backend/convex/_generated/api';
import { api as privateApi } from './.generated/clerk/packages/backend/convex/_generated/api';
const noneModules = import.meta.glob(
  './.generated/none/packages/backend/convex/**/*.{js,ts}',
);
const clerkModules = import.meta.glob(
  './.generated/clerk/packages/backend/convex/**/*.{js,ts}',
);

test('public query and mutation persist and trim messages', async () => {
  const t = convexTest(noneSchema, noneModules);
  expect(await t.query(publicApi.messages.list, {})).toEqual([]);
  const id = await t.mutation(publicApi.messages.send, { body: ' hello ' });
  expect(await t.query(publicApi.messages.list, {})).toMatchObject([
    { _id: id, body: 'hello' },
  ]);
});
test('mutation rejects blank and oversized input', async () => {
  const t = convexTest(noneSchema, noneModules);
  await expect(
    t.mutation(publicApi.messages.send, { body: ' ' }),
  ).rejects.toThrow('1 to 1000');
  await expect(
    t.mutation(publicApi.messages.send, { body: 'x'.repeat(1001) }),
  ).rejects.toThrow('1 to 1000');
});
test('query returns the latest fifty messages', async () => {
  const t = convexTest(noneSchema, noneModules);
  for (let i = 0; i < 55; i++)
    await t.mutation(publicApi.messages.send, { body: `message-${i}` });
  const messages = await t.query(publicApi.messages.list, {});
  expect(messages).toHaveLength(50);
  expect(messages[0]?.body).toBe('message-54');
});
test('Clerk backend rejects unauthenticated reads and writes', async () => {
  const t = convexTest(clerkSchema, clerkModules);
  await expect(t.query(privateApi.messages.list, {})).rejects.toThrow(
    'Sign in',
  );
  await expect(
    t.mutation(privateApi.messages.send, { body: 'no' }),
  ).rejects.toThrow('Sign in');
});
test('Clerk identities cannot read another user’s messages', async () => {
  const t = convexTest(clerkSchema, clerkModules);
  const alice = t.withIdentity({
    subject: 'alice',
    issuer: 'https://test.clerk.accounts.dev',
  });
  const bob = t.withIdentity({
    subject: 'bob',
    issuer: 'https://test.clerk.accounts.dev',
  });
  await alice.mutation(privateApi.messages.send, { body: 'private' });
  expect(await bob.query(privateApi.messages.list, {})).toEqual([]);
  expect(await alice.query(privateApi.messages.list, {})).toMatchObject([
    { body: 'private' },
  ]);
});

const convexAuthModules = import.meta.glob(
  './.generated/convex-auth/packages/backend/convex/**/*.{js,ts}',
);

test('Convex Auth backend rejects unauthenticated reads and writes', async () => {
  const t = convexTest(convexAuthSchema, convexAuthModules);
  await expect(t.query(convexAuthApi.messages.list, {})).rejects.toThrow(
    'Sign in to access messages.',
  );
  await expect(
    t.mutation(convexAuthApi.messages.send, { body: 'no' }),
  ).rejects.toThrow('Sign in to access messages.');
});

test('Convex Auth users own messages across sessions and cannot read another user', async () => {
  const t = convexTest(convexAuthSchema, convexAuthModules);
  const { aliceId, bobId, aliceSession, secondAliceSession, bobSession } =
    await t.run(async (ctx) => {
      const aliceId = await ctx.db.insert('users', {
        email: 'alice@example.com',
      });
      const bobId = await ctx.db.insert('users', { email: 'bob@example.com' });
      const expirationTime = Date.now() + 60_000;
      const aliceSession = await ctx.db.insert('authSessions', {
        userId: aliceId,
        expirationTime,
      });
      const secondAliceSession = await ctx.db.insert('authSessions', {
        userId: aliceId,
        expirationTime,
      });
      const bobSession = await ctx.db.insert('authSessions', {
        userId: bobId,
        expirationTime,
      });
      return { aliceId, bobId, aliceSession, secondAliceSession, bobSession };
    });
  const alice = t.withIdentity({
    subject: `${aliceId}|${aliceSession}`,
    issuer: 'https://example.convex.site',
  });
  const returningAlice = t.withIdentity({
    subject: `${aliceId}|${secondAliceSession}`,
    issuer: 'https://example.convex.site',
  });
  const bob = t.withIdentity({
    subject: `${bobId}|${bobSession}`,
    issuer: 'https://example.convex.site',
  });
  await alice.mutation(convexAuthApi.messages.send, { body: 'alice private' });
  expect(await bob.query(convexAuthApi.messages.list, {})).toEqual([]);
  await bob.mutation(convexAuthApi.messages.send, { body: 'bob private' });
  expect(
    await returningAlice.query(convexAuthApi.messages.list, {}),
  ).toMatchObject([{ body: 'alice private', owner: aliceId }]);
  expect(await bob.query(convexAuthApi.messages.list, {})).toMatchObject([
    { body: 'bob private', owner: bobId },
  ]);
});

const betterAuthModules = import.meta.glob(
  './.generated/better-auth/packages/backend/convex/**/*.{js,ts}',
);

function betterAuthBackend() {
  const t = convexTest(betterAuthSchema, betterAuthModules);
  betterAuthTest.register(t);
  return t;
}

async function betterAuthUser(
  t: ReturnType<typeof betterAuthBackend>,
  name: string,
) {
  const now = Date.now();
  const user = (await t.mutation(
    betterAuthComponents.betterAuth.adapter.create,
    {
      input: {
        model: 'user',
        data: {
          name,
          email: `${name}@example.com`,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  )) as { _id: string };
  return user._id;
}

async function betterAuthSession(
  t: ReturnType<typeof betterAuthBackend>,
  userId: string,
  expiresAt = Date.now() + 60_000,
) {
  const now = Date.now();
  const session = (await t.mutation(
    betterAuthComponents.betterAuth.adapter.create,
    {
      input: {
        model: 'session',
        data: {
          userId,
          token: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
          expiresAt,
        },
      },
    },
  )) as { _id: string };
  return {
    subject: userId,
    sessionId: session._id,
    issuer: 'https://example.convex.site',
  };
}

test('Better Auth backend rejects unauthenticated reads and writes', async () => {
  const t = betterAuthBackend();
  await expect(t.query(betterAuthApi.messages.list, {})).rejects.toThrow(
    'Unauthenticated',
  );
  await expect(
    t.mutation(betterAuthApi.messages.send, { body: 'no' }),
  ).rejects.toThrow('Unauthenticated');
  expect(await t.run((ctx) => ctx.db.query('messages').take(1))).toEqual([]);
});

test('Better Auth component users own messages across sessions and cannot read another user', async () => {
  const t = betterAuthBackend();
  const aliceId = await betterAuthUser(t, 'alice');
  const bobId = await betterAuthUser(t, 'bob');
  const alice = t.withIdentity(await betterAuthSession(t, aliceId));
  const returningAlice = t.withIdentity(await betterAuthSession(t, aliceId));
  const bob = t.withIdentity(await betterAuthSession(t, bobId));
  await alice.mutation(betterAuthApi.messages.send, { body: 'alice private' });
  expect(await bob.query(betterAuthApi.messages.list, {})).toEqual([]);
  await bob.mutation(betterAuthApi.messages.send, { body: 'bob private' });
  expect(
    await returningAlice.query(betterAuthApi.messages.list, {}),
  ).toMatchObject([{ body: 'alice private', owner: aliceId }]);
  expect(await bob.query(betterAuthApi.messages.list, {})).toMatchObject([
    { body: 'bob private', owner: bobId },
  ]);
});

test('Better Auth backend rejects expired and deleted component sessions', async () => {
  const t = betterAuthBackend();
  const userId = await betterAuthUser(t, 'alice');
  const expired = t.withIdentity(
    await betterAuthSession(t, userId, Date.now() - 1000),
  );
  const deletedIdentity = await betterAuthSession(t, userId);
  await t.mutation(betterAuthComponents.betterAuth.adapter.deleteOne, {
    input: {
      model: 'session',
      where: [{ field: '_id', value: deletedIdentity.sessionId }],
    },
  });
  const deleted = t.withIdentity(deletedIdentity);
  for (const client of [expired, deleted]) {
    await expect(client.query(betterAuthApi.messages.list, {})).rejects.toThrow(
      'Unauthenticated',
    );
    await expect(
      client.mutation(betterAuthApi.messages.send, { body: 'no' }),
    ).rejects.toThrow('Unauthenticated');
  }
  expect(await t.run((ctx) => ctx.db.query('messages').take(1))).toEqual([]);
});

const workosModules = import.meta.glob(
  './.generated/workos/packages/backend/convex/**/*.{js,ts}',
);

test('WorkOS backend rejects unauthenticated reads and writes', async () => {
  const t = convexTest(workosSchema, workosModules);
  await expect(t.query(workosApi.messages.list, {})).rejects.toThrow('Sign in');
  await expect(
    t.mutation(workosApi.messages.send, { body: 'no' }),
  ).rejects.toThrow('Sign in');
});

test('WorkOS subjects own messages across sessions and isolate other users', async () => {
  const t = convexTest(workosSchema, workosModules);
  const alice = t.withIdentity({
    subject: 'user_alice',
    issuer: 'https://api.workos.com',
    sid: 'session_one',
  });
  const returningAlice = t.withIdentity({
    subject: 'user_alice',
    issuer: 'https://api.workos.com',
    sid: 'session_two',
  });
  const bob = t.withIdentity({
    subject: 'user_bob',
    issuer: 'https://api.workos.com',
    sid: 'session_three',
  });
  await alice.mutation(workosApi.messages.send, { body: 'alice private' });
  expect(await bob.query(workosApi.messages.list, {})).toEqual([]);
  await bob.mutation(workosApi.messages.send, { body: 'bob private' });
  expect(await returningAlice.query(workosApi.messages.list, {})).toMatchObject(
    [{ body: 'alice private', owner: 'user_alice' }],
  );
  expect(await bob.query(workosApi.messages.list, {})).toMatchObject([
    { body: 'bob private', owner: 'user_bob' },
  ]);
});
