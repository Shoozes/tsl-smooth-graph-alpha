import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAX_STATIC_FILE_BYTES = 64 * 1024 * 1024;

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp']
]);

/**
 * Starts a deliberately narrow local server for browser proof fixtures.
 * Every route maps to one approved directory; realpath containment is checked
 * before a file is read and unknown content is never executable.
 */
export async function createStaticFixtureServer(routes) {
  const normalizedRoutes = await normalizeRoutes(routes);
  const server = createServer((request, response) => {
    void handleRequest(request, response, normalizedRoutes);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('The browser fixture server did not receive a TCP address.');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await closeServer(server);
    }
  };
}

async function normalizeRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error('Static fixture server requires at least one approved route.');
  }
  const normalized = await Promise.all(routes.map(async (route) => {
    if (!route || typeof route.prefix !== 'string' || typeof route.root !== 'string') {
      throw new Error('Each static fixture route requires a prefix and root.');
    }
    const prefix = normalizePrefix(route.prefix);
    const root = path.resolve(route.root);
    return { prefix, root, realRoot: await realpath(root) };
  }));
  return normalized.sort((left, right) => right.prefix.length - left.prefix.length);
}

async function handleRequest(request, response, routes) {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      respond(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }
    const pathname = readPathname(request.url);
    const route = selectRoute(pathname, routes);
    if (!route) {
      respond(response, 404, 'Not found');
      return;
    }
    const file = await resolveRouteFile(route, pathname);
    if (!file) {
      respond(response, 404, 'Not found');
      return;
    }
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_STATIC_FILE_BYTES) {
      respond(response, 404, 'Not found');
      return;
    }
    response.writeHead(200, securityHeaders({
      'Content-Length': String(info.size),
      'Content-Type': contentTypeFor(file)
    }));
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    await pipeline(createReadStream(file), response);
  } catch (error) {
    if (!response.headersSent) {
      const status = error instanceof StaticRouteError ? error.status : 500;
      respond(response, status, status === 500 ? 'Fixture server failure' : 'Not found');
      return;
    }
    response.destroy(error instanceof Error ? error : undefined);
  }
}

function readPathname(url) {
  try {
    return decodeURIComponent(new URL(url ?? '/', 'http://fixture.local').pathname);
  } catch {
    throw new StaticRouteError(404);
  }
}

function selectRoute(pathname, routes) {
  return routes.find((route) => route.prefix === '/'
    ? pathname.startsWith('/')
    : pathname === route.prefix || pathname.startsWith(`${route.prefix}/`));
}

async function resolveRouteFile(route, pathname) {
  const relative = route.prefix === '/'
    ? pathname.slice(1)
    : pathname.slice(route.prefix.length).replace(/^\/+/, '');
  if (!relative || relative.includes('\0')) {
    return undefined;
  }
  const candidate = path.resolve(route.root, relative);
  if (!isWithin(candidate, route.root)) {
    throw new StaticRouteError(404);
  }
  try {
    const resolved = await realpath(candidate);
    if (!isWithin(resolved, route.realRoot)) {
      throw new StaticRouteError(404);
    }
    return resolved;
  } catch (error) {
    if (error instanceof StaticRouteError) {
      throw error;
    }
    return undefined;
  }
}

function normalizePrefix(prefix) {
  const value = `/${prefix.replace(/^\/+|\/+$/g, '')}`;
  return value === '/' ? '/' : value;
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function contentTypeFor(file) {
  return MIME_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream';
}

function securityHeaders(headers) {
  return {
    ...headers,
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff'
  };
}

function respond(response, status, body, headers = {}) {
  response.writeHead(status, securityHeaders({
    'Content-Length': String(Buffer.byteLength(body)),
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers
  }));
  response.end(body);
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

class StaticRouteError extends Error {
  constructor(status) {
    super('Rejected static fixture route.');
    this.status = status;
  }
}
