import type { AppTemplate } from '../../../generator/types.js';
import { versions } from '../../versions.js';
import { common, entryContent, manifest } from '../shared.js';

export const expoTemplate: AppTemplate = {
  id: 'expo',
  label: 'Expo / React Native',
  async generate(context, app) {
    const dir = `apps/${app.name}`;
    const entry = entryContent(context, app, './src');
    const pkg = manifest(context, app);
    pkg.main = 'index.ts';
    const devPort =
      8081 + context.options.apps.findIndex((entry) => entry.name === app.name);
    pkg.scripts = {
      ...pkg.scripts,
      dev: `expo start --port ${devPort}`,
      android: 'expo run:android',
      ios: 'expo run:ios',
      build: 'expo export --platform ios --platform android',
    };
    pkg.dependencies = {
      ...pkg.dependencies,
      expo: versions.expo,
      'react-native': versions.reactNative,
    };
    await context.json(`${dir}/package.json`, pkg);
    await context.json(`${dir}/tsconfig.json`, {
      extends: 'expo/tsconfig.base',
      compilerOptions: { strict: true, noEmit: true },
      include: ['**/*.ts', '**/*.tsx'],
      exclude: ['node_modules', 'dist'],
    });
    await context.json(`${dir}/app.json`, {
      expo: {
        name: app.name,
        slug: `${context.options.name}-${app.name}`,
        scheme: `ccm-${context.options.name}-${app.name}`,
        version: '1.0.0',
        orientation: 'portrait',
        userInterfaceStyle: 'automatic',
        ios: { supportsTablet: true },
      },
    });
    await context.write(
      `${dir}/metro.config.cjs`,
      `const { getDefaultConfig } = require('expo/metro-config');\nmodule.exports = getDefaultConfig(__dirname);\n`,
    );
    await context.write(
      `${dir}/index.ts`,
      `import { registerRootComponent } from 'expo';\nimport App from './App';\nregisterRootComponent(App);\n`,
    );
    await context.write(
      `${dir}/App.tsx`,
      `import { Providers } from './src/providers';
import { AuthControls } from './src/auth-controls';
${entry.imports}
export default function App() {
  return <Providers><AuthControls />${entry.content}</Providers>;
}
`,
    );
    if (context.options.example === 'messages')
      await context.write(
        `${dir}/src/messages.tsx`,
        `import { useState } from 'react';
import { Button, ScrollView, Text, TextInput, View } from 'react-native';
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
  return <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 64 }} keyboardShouldPersistTaps="handled">
    <Text accessibilityRole="header">Messages</Text>
    {messages === undefined ? <Text>Loading messages…</Text> : messages.length === 0 ? <Text>No messages yet.</Text> :
      messages.map((message) => <Text key={message._id}>{message.body}</Text>)}
    <View>
      <TextInput accessibilityLabel="Message" placeholder="Message" value={body} onChangeText={setBody} maxLength={1000} editable={!pending} style={{ borderWidth: 1, padding: 12, marginVertical: 12 }} />
      <Button title={pending ? 'Sending…' : 'Send'} disabled={pending || !body.trim()} onPress={() => { void submit(); }} />
    </View>
    {error && <Text accessibilityRole="alert">{error}</Text>}
  </ScrollView>;
}
`,
      );
    await common(context, app, 'EXPO_PUBLIC_CONVEX_URL');
  },
};
