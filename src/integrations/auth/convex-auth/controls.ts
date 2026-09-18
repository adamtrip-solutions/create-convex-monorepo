import type { OAuthProvider } from '../../../generator/types.js';

export function authControls(
  native: boolean,
  oauth: readonly OAuthProvider[] = [],
  scheme = '',
): string {
  return `'use client';
import { useState } from 'react';
import { useConvexAuth } from 'convex/react';
import { useAuthActions } from '@convex-dev/auth/react';
${native ? "import { Button, ScrollView, Text, TextInput, View } from 'react-native';" : ''}
${
  native && oauth.length
    ? `import * as Linking from 'expo-linking';
import { openAuthSessionAsync } from 'expo-web-browser';`
    : ''
}

export function AuthControls() {
  const { isAuthenticated } = useConvexAuth();
  const { signIn, signOut } = useAuthActions();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [flow, setFlow] = useState<'signIn' | 'signUp'>('signIn');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function authenticate() {
    if (pending) return;
    setPending(true); setError(null);
    try {
      await signIn('password', { email: email.trim(), password, flow });
      setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in. Try again.');
    } finally { setPending(false); }
  }
  ${
    oauth.length
      ? `async function authenticateOAuth(provider: ${oauth.map((provider) => `'${provider}'`).join(' | ')}) {
    if (pending) return;
    setPending(true); setError(null);
    try {
      ${
        native
          ? `const redirectTo = Linking.createURL('auth', { scheme: '${scheme}' });
      const { redirect } = await signIn(provider, { redirectTo });
      if (!redirect) throw new Error('The provider did not return a sign-in URL.');
      const result = await openAuthSessionAsync(redirect.toString(), redirectTo);
      if (result.type === 'success') {
        const code = new URL(result.url).searchParams.get('code');
        if (!code) throw new Error('The sign-in response did not include a code.');
        await signIn(provider, { code });
      }`
          : `await signIn(provider);`
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in. Try again.');
    } finally { setPending(false); }
  }`
      : ''
  }
  async function logout() {
    if (pending) return;
    setPending(true); setError(null);
    try { await signOut(); }
    catch { setError('Could not sign out. Try again.'); }
    finally { setPending(false); }
  }
  function toggleFlow() {
    setFlow(flow === 'signIn' ? 'signUp' : 'signIn');
    setError(null);
  }
  ${
    native
      ? `return <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 64 }} keyboardShouldPersistTaps="handled">
    {isAuthenticated ? <Button title={pending ? 'Signing out…' : 'Sign out'} disabled={pending} onPress={() => { void logout(); }} /> : <View>
      <Text accessibilityRole="header">{flow === 'signIn' ? 'Sign in' : 'Create an account'}</Text>
      <TextInput accessibilityLabel="Email" placeholder="Email" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" value={email} onChangeText={setEmail} editable={!pending} style={{ borderWidth: 1, padding: 12, marginVertical: 12 }} />
      <TextInput accessibilityLabel="Password" placeholder="Password" secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete={flow === 'signUp' ? 'new-password' : 'current-password'} value={password} onChangeText={setPassword} editable={!pending} style={{ borderWidth: 1, padding: 12, marginVertical: 12 }} />
      <Button title={pending ? 'Please wait…' : flow === 'signIn' ? 'Sign in' : 'Sign up'} disabled={pending || !email.trim() || !password} onPress={() => { void authenticate(); }} />
      <Button title={flow === 'signIn' ? 'Sign up instead' : 'Sign in instead'} disabled={pending} onPress={toggleFlow} />
      ${oauth.map((provider) => `<Button title="Sign in with ${provider === 'github' ? 'GitHub' : 'Google'}" disabled={pending} onPress={() => { void authenticateOAuth('${provider}'); }} />`).join('\n')}
    </View>}
    {error && <Text accessibilityRole="alert">{error}</Text>}
  </ScrollView>;`
      : `return <div>
    {isAuthenticated ? <button type="button" disabled={pending} onClick={() => { void logout(); }}>{pending ? 'Signing out…' : 'Sign out'}</button> : <form onSubmit={(event) => { event.preventDefault(); void authenticate(); }}>
      <h2>{flow === 'signIn' ? 'Sign in' : 'Create an account'}</h2>
      <label>Email <input name="email" type="email" autoComplete="email" required value={email} disabled={pending} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Password <input name="password" type="password" autoComplete={flow === 'signUp' ? 'new-password' : 'current-password'} required minLength={flow === 'signUp' ? 8 : undefined} value={password} disabled={pending} onChange={(event) => setPassword(event.target.value)} /></label>
      <button type="submit" disabled={pending}>{pending ? 'Please wait…' : flow === 'signIn' ? 'Sign in' : 'Sign up'}</button>
      <button type="button" disabled={pending} onClick={toggleFlow}>{flow === 'signIn' ? 'Sign up instead' : 'Sign in instead'}</button>
      ${oauth.map((provider) => `<button type="button" disabled={pending} onClick={() => { void authenticateOAuth('${provider}'); }}>Sign in with ${provider === 'github' ? 'GitHub' : 'Google'}</button>`).join('\n')}
    </form>}
    {error && <p role="alert">{error}</p>}
  </div>;`
  }
}
`;
}
