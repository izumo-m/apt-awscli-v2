/**
 * Reverse Proxy Worker
 *
 * Environment:
 *   ORIGIN_BASE_URL - origin URL
 *                     Example: https://my-bucket.s3.ap-northeast-1.amazonaws.com/prefix
 */

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (!env.ORIGIN_BASE_URL) {
      return new Response("ORIGIN_BASE_URL not configured", { status: 500 });
    }

    const { pathname, search } = new URL(request.url);
    const resolvedPath = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const originUrl = `${env.ORIGIN_BASE_URL.replace(/\/+$/, "")}${resolvedPath}${search}`;

    // Only forward the request headers we want S3 to see. Sending an explicit
    // empty value (e.g. `If-None-Match: ""`) is not the same as omitting the
    // header, so each conditional header is set only when the client actually
    // supplied one. `Accept` falls back to */* so S3 always sees one.
    const headers = new Headers();
    headers.set("Accept", request.headers.get("Accept") || "*/*");
    for (const name of ["Accept-Encoding", "If-None-Match", "If-Modified-Since"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    return fetch(originUrl, {
      method: request.method,
      headers,
      cf: { cacheEverything: true },
    });
  },
};
