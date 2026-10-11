// --- E05-R03: 405 with an `Allow` header, for every registered path ----------
//
// Fastify answers 404 for a known path with an unregistered method, and
// `method-not-allowed` was therefore a problem kind nothing ever sent
// (E05-R10's review). The calendars routes are the first paths with several
// methods, so the answer becomes real here: an `onRoute` hook records every
// registered route's template and methods, and the not-found handler asks this
// table whether the path exists under another method before it answers 404.
//
// The set is built from Fastify's own route table — the same one the router
// matched against — so `/healthz` and `/me` are covered without naming them,
// and a route added later is covered without touching this file. Methods are
// reported in a fixed order, and `Allow` is the only thing a refusal adds: the
// body stays the fixed problem document.
//
// Not here: `OPTIONS` (no route registers it) and the authentication of a
// request — both hooks run before the not-found handler, so a request with no
// valid token is still a 401 and never a hint about which methods exist.

/**
 * Whether one Fastify route template matches a concrete path. Templates are
 * static segments plus `:param` (and `*`), which is all this service registers;
 * a parameter matches exactly one non-empty segment, so `/calendars//` is not
 * `/calendars/:id`.
 * @param {string} template a Fastify route url, e.g. `/calendars/:id`
 * @param {string} pathname a concrete request path without its query string
 */
export function matchesTemplate(template, pathname) {
  const templateParts = template.split('/');
  const pathParts = pathname.split('/');
  if (templateParts.length !== pathParts.length) return false;
  for (let index = 0; index < templateParts.length; index += 1) {
    const part = templateParts[index];
    if (part === '*') return true;
    if (part.startsWith(':')) {
      if (pathParts[index] === '') return false;
      continue;
    }
    if (part !== pathParts[index]) return false;
  }
  return true;
}

/** The path of a request URL, without its query string. @param {unknown} url */
export function pathOf(url) {
  const raw = typeof url === 'string' ? url : '';
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}

/**
 * The route table `Allow` is answered from. `buildApp` feeds it through an
 * `onRoute` hook and reads it in the not-found handler.
 */
export function createAllowRegistry() {
  /** @type {Map<string, Set<string>>} */
  const routes = new Map();
  return {
    /**
     * @param {string} url the route template
     * @param {string | string[]} method
     */
    add(url, method) {
      const methods = routes.get(url) ?? new Set();
      for (const entry of Array.isArray(method) ? method : [method]) {
        methods.add(String(entry).toUpperCase());
      }
      routes.set(url, methods);
    },
    /**
     * The methods a path is registered under, or undefined when no route
     * template matches it (which is a 404, not a 405).
     * @param {unknown} url the request's URL, query string included
     * @returns {string[] | undefined}
     */
    allowFor(url) {
      const pathname = pathOf(url);
      for (const [template, methods] of routes) {
        if (matchesTemplate(template, pathname)) {
          return [...methods].sort();
        }
      }
      return undefined;
    },
  };
}
