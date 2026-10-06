import { createClient } from '../src/index.ts';
const client = createClient({ baseUrl: 'https://api.localhost:8443' });
// @ts-expect-error Unknown operations must not compile.
client.GET('/unknown');
const { data } = await client.GET('/healthz');
if (data) {
  const status: 'ok' = data.status;
  void status;
  // @ts-expect-error The response is not any.
  data.unknownField;
}
