import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: 'openapi.json',
  output: 'apps/cli/src/generated',
  plugins: [
    {
      name: '@hey-api/sdk',
      responseStyle: 'data',
    },
    {
      name: '@hey-api/client-fetch',
      // Match the legacy 0.46 client contract: SDK calls await to the
      // response body directly and reject with the transport error instead
      // of resolving `{ data, error }`.
      responseStyle: 'data',
      throwOnError: true,
    },
  ],
});
