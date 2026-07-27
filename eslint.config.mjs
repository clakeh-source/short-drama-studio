import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

/**
 * Provider SDKs may only be imported from within /lib/providers.
 * This is the load-bearing architectural constraint of the build: everything
 * else in the app talks to the interfaces in lib/providers/types.ts.
 */
const PROVIDER_SDKS = [
  '@anthropic-ai/sdk',
  'replicate',
  'elevenlabs',
  '@elevenlabs/elevenlabs-js',
  'shotstack-sdk',
  'creatomate',
  'fluent-ffmpeg',
];

const eslintConfig = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'drizzle/**',
      'next-env.d.ts',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // Anything that is NOT lib/providers/** is barred from provider SDKs.
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    ignores: ['lib/providers/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: PROVIDER_SDKS.map((name) => ({
            name,
            message:
              'Provider SDKs may only be imported inside /lib/providers. Use the VideoProvider / TtsProvider / RenderProvider interfaces instead.',
          })),
          patterns: [
            {
              group: PROVIDER_SDKS.map((n) => `${n}/*`),
              message: 'Provider SDKs may only be imported inside /lib/providers.',
            },
          ],
        },
      ],
    },
  },
  {
    // Client components must never touch server-only env or the db.
    files: ['components/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/lib/db', '@/lib/db/*', '@/lib/env', '@/lib/providers/*'],
              message:
                'Client components must not import server modules. Pass data down from a server component.',
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
