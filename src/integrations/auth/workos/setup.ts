export function workosSetup(scope: string, messages: boolean): string {
  return `## WorkOS setup

Use one WorkOS environment across these frontends so the same account has the same identity. In the WorkOS dashboard, configure each app's redirect URI, initiate login URI at /sign-in, and allowed sign-out URI at its origin. Next.js and TanStack Start use /callback; Vite returns to /. Use the actual development ports listed in each app's .env.workos.example. Register every app's origin, including its development port and production origin, as an allowed [sign-out URI](https://workos.com/docs/authkit/sessions#sign-out-uris). The sign-out controls pass window.location.origin as returnTo so users return to the app they signed out of. Add Vite's origin to the allowed CORS origins. For production Vite apps, configure a custom Authentication API domain on the same site and set VITE_WORKOS_API_HOSTNAME to its hostname.

Append each app's .env.workos.example to its .env.local alongside the Convex URL. WORKOS_CLIENT_ID is public. Set the framework-prefixed value in every app; Next.js and TanStack Start also need the same value as WORKOS_CLIENT_ID because their server SDKs read that name. WORKOS_API_KEY and WORKOS_COOKIE_PASSWORD are server secrets used only by Next.js and TanStack Start. Generate a random cookie password of at least 32 characters with openssl rand -base64 32. Never give either secret a NEXT_PUBLIC_, VITE_ or EXPO_PUBLIC_ prefix.

Keep the app-specific WORKOS_COOKIE_NAME=wos-session-<app name> from each server app's environment example. The Next.js and TanStack Start SDKs read WORKOS_COOKIE_NAME directly for their session cookies. Cookies are shared across localhost ports, so distinct names prevent one app from overwriting another app's session. Use a different name for every server app on the same hostname.

Set the client ID and AuthKit issuer on the Convex deployment:

\`\`\`sh
pnpm --filter @${scope}/backend exec convex env set WORKOS_CLIENT_ID client_your_client_id
pnpm --filter @${scope}/backend exec convex env set WORKOS_AUTHKIT_ISSUER_DOMAIN https://api.workos.com/user_management/client_your_client_id
\`\`\`

Use the exact client-specific issuer URL, including /user_management/ and your real client ID. In WorkOS, edit the session JWT template to include an aud claim equal to that same client ID, for example { "aud": "client_your_client_id" }. Preserve any existing claims. Sign out and back in after changing the template. Session tokens omit aud by default, so this step is required for auth.config.ts, which uses WORKOS_CLIENT_ID as applicationID. A plain https://api.workos.com/ URL or the hosted sign-in page URL is not this issuer. See packages/backend/.env.workos.example. On a fresh deployment, run pnpm convex:setup to select it. If the push asks for those variables, set them in another terminal and rerun setup. Configure production separately. This starter uses OIDC discovery with domain/applicationID validation. Convex's current AuthKit guide instead shows customJwt providers with explicit JWKS URLs and support for audience-less session tokens; do not copy that setup partially into this configuration.

The frontend SDK supplies an access token through ConvexProviderWithAuth. Protected children wait until Convex validates the token. Next.js and TanStack Start use server-managed sessions, but this starter does not preload authenticated Convex queries during SSR. Hosted AuthKit controls the enabled sign-in methods.

${messages ? 'Messages use identity.subject from ctx.auth.getUserIdentity() as the owner key. Sessions for the same WorkOS account share messages.' : 'The blank starter retains the providers and sign-in controls. Add ctx.auth.getUserIdentity() checks to each protected backend function you write.'} WorkOS ownership differs from Clerk's tokenIdentifier and Convex Auth's users table ID. Changing providers needs a data migration; provider replacement is unsupported. Install this adapter in an existing no-auth workspace with add auth workos and follow WORKOS_SETUP.md.

Expo is unsupported because no official Expo or React Native AuthKit SDK was found. See [WorkOS SDKs](https://workos.com/docs/sdks), [Convex integration](https://docs.convex.dev/auth/authkit/add-to-app), and the SDK setup guides for [Next.js](https://github.com/workos/authkit-nextjs), [React](https://github.com/workos/authkit-react), and [TanStack Start](https://github.com/workos/authkit-tanstack-start).
`;
}
