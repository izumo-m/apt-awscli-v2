/**
 * Reverse Proxy Worker
 *
 * Environment:
 *   ORIGIN_BASE_URL - origin URL
 *                     例: https://my-bucket.s3.ap-northeast-1.amazonaws.com/prefix
 */

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const { pathname, search } = new URL(request.url);
    const resolvedPath = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const originUrl = `${env.ORIGIN_BASE_URL.replace(/\/+$/, "")}${resolvedPath}${search}`;

    return fetch(originUrl, {
      method: request.method,
      headers: {
        "Accept": request.headers.get("Accept") || "*/*",
        "Accept-Encoding": request.headers.get("Accept-Encoding") || "",
        "If-None-Match": request.headers.get("If-None-Match") || "",
        "If-Modified-Since": request.headers.get("If-Modified-Since") || "",
      },
      cf: { cacheEverything: true },
    });
  },
};
