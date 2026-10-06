import createFetchClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './schema.d.ts';

export function createClient(options: ClientOptions) {
  return createFetchClient<paths>(options);
}
