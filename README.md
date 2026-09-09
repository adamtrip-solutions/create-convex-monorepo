# create-convex-monorepo

A TypeScript CLI that generates pnpm and Turborepo workspaces with multiple frontends sharing one typed Convex backend. Choose Next.js, Vite + React, TanStack Start, Expo, or a combination, with optional Clerk authentication.

The generator composes framework templates and auth adapters. It does not copy a single starter and delete unwanted pieces. Choose blank apps or a messages example. The example includes a query and mutation, plus compile-time assertions for the shared API's argument and return types.

## Why this exists

Convex already generates an API from your backend functions. Sharing that API between independently bundled web and native apps should preserve its types without duplicating backend code. This project supplies the workspace wiring, framework-specific environment handling, and checks needed to keep that boundary intact.

## Usage

Requires Node.js 22.12 or newer and pnpm for the generated workspace.

```sh
pnpm create convex-monorepo@latest
```

Or use npx:

```sh
npx create-convex-monorepo@latest
```

Both commands run the same CLI. You can also install it globally with `npm install --global create-convex-monorepo` and run `create-convex-monorepo` directly. Running through npx does not change the generated workspace's package manager, which is pnpm.

Contributors can run the checkout with `pnpm dev`; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Interactive usage

With a terminal attached, the CLI asks for missing choices:

```text
Project name?           my-app
Package manager?        pnpm
Application framework?  Next.js
Application name?       web
Add another frontend?   Yes
Application framework?  Expo / React Native
Application name?       mobile
Add another frontend?   No
Authentication?         Clerk
Starter content?        Blank project
Initialize git?         Yes
Initialize Convex and link frontend URLs?   Yes
```

Selecting Convex initialization installs dependencies first, then opens Convex's own account and deployment prompts. Declining it leaves a separate dependency-install prompt. Turborepo and the backend, TypeScript config, and ESLint config packages are included in every v0.1 project.

## Non-interactive usage

```sh
pnpm create convex-monorepo@latest my-app --apps next,expo --example none --init-convex --yes
npx create-convex-monorepo@latest my-app --apps next,expo --auth clerk --yes
pnpm create convex-monorepo@latest my-app --apps web:next,admin:vite --no-install --no-git
pnpm create convex-monorepo@latest my-app --apps app:tanstack-start,dashboard:next --auth none --package-manager pnpm --yes
```

| Option                              | Meaning                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| `--apps`                            | Comma-separated framework IDs or `name:framework` entries   |
| `--auth`                            | `none`, the default, or `clerk`                             |
| `--example`                         | `messages`, the default, or `none` for blank projects       |
| `--package-manager`                 | `pnpm`; other managers are rejected in v0.1                 |
| `--install`, `--no-install`         | Enable or skip dependency installation                      |
| `--init-convex`, `--no-init-convex` | Initialize Convex and link URLs; enables installation       |
| `--git`, `--no-git`                 | Enable or skip `git init`; no commit is created             |
| `--yes`, `-y`                       | Skip prompts and accept defaults, including install and git |
| `--help`, `--version`               | Show usage or the generator version                         |

Without a terminal, prompts are disabled and install/git default to off unless explicitly enabled or `--yes` is passed. Explicit negative flags override `--yes`. Convex initialization defaults to off when prompts are skipped, including with `--yes`; request it explicitly with `--init-convex`. That flag still lets Convex prompt for an account or deployment, and conflicts with `--no-install`. The default app is Next.js. Project and app names must be lowercase letters, digits, and hyphens, at most 100 characters, with no path separators or reserved device names.

## Blank projects

Choose **Blank project** in the starter-content prompt, or pass `--example none`:

```sh
pnpm create convex-monorepo@latest my-app --apps next,expo --example none --yes
```

Every selected app starts with a minimal page or screen showing its name. Convex providers, workspace dependencies, environment setup, and the selected auth integration remain configured. The backend has an empty schema and official generated types. There are no example tables, messages functions, access helpers, query/mutation screens, or demo-specific type-test files to remove.

Add your tables to `packages/backend/convex/schema.ts` and your functions beside it. Run `pnpm convex:dev` to generate their shared API references. With Clerk, add server-side identity and authorization checks to your protected functions. The blank starter retains sign-in controls and the existing authenticated provider behavior.

The choice applies to the whole workspace. `--example messages` keeps the existing query/mutation demo and remains the default, including with `--yes`.

## Supported frameworks

| ID               | Application              | Public Convex variable   |
| ---------------- | ------------------------ | ------------------------ |
| `next`           | Next.js App Router       | `NEXT_PUBLIC_CONVEX_URL` |
| `vite`           | Vite + React             | `VITE_CONVEX_URL`        |
| `tanstack-start` | TanStack Start with Vite | `VITE_CONVEX_URL`        |
| `expo`           | Expo / React Native      | `EXPO_PUBLIC_CONVEX_URL` |

Versions are pinned in the templates. Start uses ordinary Convex React hooks; server-side Convex prefetching is not configured. Expo's build command exports JavaScript, not native application binaries. See [research and upstream caveats](docs/research.md).

## Generated architecture

```text
my-app/
├── apps/
│   ├── web/
│   ├── admin/                         # if selected
│   └── mobile/                        # if selected
├── packages/
│   ├── backend/
│   │   ├── convex/_generated/
│   │   ├── convex/schema.ts
│   │   ├── convex/messages.ts  # messages example only
│   │   ├── convex.json
│   │   └── package.json
│   ├── typescript-config/
│   └── eslint-config/
├── convex-monorepo.json
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

`convex-monorepo.json` records the selected applications and auth provider. It is metadata for later tooling; it does not implement upgrade or add commands.

## Multiple frontends

Use explicit names to choose folders and repeat a framework:

```sh
pnpm create convex-monorepo@latest acme --apps web:next,admin:next,mobile:expo --yes
```

Apps become `@acme/web`, `@acme/admin`, and `@acme/mobile`. All depend on `@acme/backend` through `workspace:*`. The generator assigns distinct web development ports. v0.1 creates a new workspace; adding an app to an existing workspace is not implemented.

## First run and development

Inside the generated project:

```sh
pnpm install             # if installation was skipped
pnpm convex:setup
```

Skip these commands if you selected initialization during generation. Setup runs the installed Convex CLI in `packages/backend`, selects or creates a deployment, and pushes once. After success, it links the backend's `CONVEX_URL` to every app's `.env.local` using that framework's public variable. Existing comments and other settings remain intact; backend credentials stay in the backend. For Clerk, follow the next section before completing the backend push.

After switching deployments, run `pnpm convex:link` to refresh the frontend URLs without initializing or pushing again. Restart development processes after linking. This updates local files only; configure production URLs separately in your hosting provider.

```sh
pnpm dev                 # one backend watcher and all selected apps
pnpm dev:web             # only the named app
pnpm convex:dev          # only the backend watcher
pnpm typecheck
pnpm lint
pnpm build
```

Complete setup in a normal terminal before starting Turbo. Stop a separately running backend watcher before `pnpm dev`, which starts its own. Public environment values are embedded at build time; rebuild frontends when they change. Backend build checks types and does not deploy.

## Convex backend sharing

```ts
import { api } from '@my-app/backend/api';
import type { Doc, Id } from '@my-app/backend/dataModel';
```

`/api` points directly to Convex's original runtime JavaScript and paired declaration file. `/dataModel` is a type-only export. There is no bundled declaration file or root barrel. Keep the backend sources and `convex/_generated` in version control, and run `pnpm convex:dev` after changing backend modules.

Dynamic Convex declarations refer to backend source modules. Client TypeScript programs therefore inspect those sources, even though client runtime bundles should not include the backend implementations. Do not introduce incompatible backend-only path aliases or a frontend `rootDir` that excludes those sources. Apps using the messages example include `src/convex-api.type-test.ts` to detect lost inference. Blank API types are checked in disposable test fixtures. The [architecture](docs/architecture.md) explains the export contract.

## Authentication

`--auth clerk` adds SDK-specific bindings, a Convex auth configuration, and provider wiring. The messages example also includes backend identity checks and an owner index that keeps messages private. With `--auth none`, that example is a public message board. Blank projects have no data or functions; add authorization checks when writing protected functions. UI visibility alone is not authorization.

Use one Clerk application across the frontends. Configure Clerk's Convex integration and a JWT template named `convex`. Set `CLERK_JWT_ISSUER_DOMAIN` on the Convex deployment:

```sh
pnpm --filter @my-app/backend exec convex env set CLERK_JWT_ISSUER_DOMAIN https://your-instance.clerk.accounts.dev
```

On a fresh deployment, first run `pnpm convex:setup` to select it. If the push reports a missing issuer, set that value and rerun setup. Repeat the configuration for production.

Append the variables from each app's `.env.clerk.example` to its `.env.local`, alongside the Convex URL. Publishable keys belong in the appropriate public variables. Next.js and Start use a server-only `CLERK_SECRET_KEY`; Vite and Expo must never receive that secret. See [Convex's Clerk guide](https://docs.convex.dev/auth/clerk).

## Expo notes

Expo uses the SDK's React and React Native versions, the default `expo/metro-config`, and a shared workspace backend dependency. Do not add old manual symlink resolver overrides or upgrade React independently in one app.

Use a cloud development deployment for physical devices; `localhost` on a phone refers to the phone itself. The Clerk example uses Google OAuth and SecureStore token caching. Enable Google's connection and the Native API in your Clerk application, allow the generated scheme redirect listed in `.env.clerk.example`, and use a native development build for that scheme. Additional MFA and session-task flows are not implemented.

Typechecking and Metro export checks do not establish that real OAuth, device permissions, or native binaries work. Those require your Clerk configuration and device testing. See [Expo monorepos](https://docs.expo.dev/guides/monorepos/) and [Clerk Expo setup](https://clerk.com/docs/expo/getting-started/quickstart).

## Troubleshooting

- **Destination already exists:** choose a new or empty directory. The CLI refuses non-empty directories and symlinks. Template failures remove staging output; install/git/Convex setup failures preserve the completed project and print a retry command.
- **Missing URL screen:** run `pnpm convex:setup`, or `pnpm convex:link` if the backend is already configured, then restart development.
- **Authentication never connects:** check the `convex` JWT template and deployment issuer. Use the same Clerk application across frontends.
- **Missing API types:** keep both generated JavaScript and declarations, run the backend watcher, and verify matching Convex versions. Do not fix this by casting the API.
- **Missing Start route tree:** run that app's `routes:generate` script. Its typecheck script runs route generation automatically.
- **Metro resolution after dependency changes:** run `pnpm --filter @my-app/mobile exec expo start --clear`. Check SDK-compatible dependency versions before changing resolver settings.

[Research](docs/research.md) records upstream reports about declaration bundling, large backend type graphs, hoisted Node external packages, and Windows component symlinks. An open report is not proof that its failure reproduces on the pinned versions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [adding a framework](docs/adding-a-framework.md), and [adding an auth provider](docs/adding-an-auth-provider.md). Run generated-project checks when changing templates; generator unit tests alone cannot verify a framework bundler.

## Roadmap

The next release should add `doctor` to check deployment URLs, generated types, version alignment, and auth setup in an existing workspace. Later candidates are `add app`, another auth provider, and additional package-manager adapters. These commands are not available in v0.1.

MIT licensed. See [LICENSE](LICENSE).

## Verification record

See [the v0.1 verification record](docs/verification.md) for executed installs, typechecks, framework builds, Metro exports, backend tests and remaining runtime limits.
