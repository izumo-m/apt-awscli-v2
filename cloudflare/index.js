/**
 * Reverse Proxy Worker
 *
 * Environment:
 *   ORIGIN_BASE_URL - origin URL
 *                     Example: https://my-bucket.s3.ap-northeast-1.amazonaws.com/prefix
 *   ANALYTICS       - optional Workers Analytics Engine dataset binding.
 *                     When bound, one data point is written per proxied
 *                     request (column layout: see buildDataPoint below).
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

    const response = await fetch(originUrl, {
      method: request.method,
      headers,
      cf: { cacheEverything: true },
    });

    if (env.ANALYTICS) {
      // writeDataPoint is fire-and-forget; a failure here must never affect
      // the response returned to the client.
      try {
        env.ANALYTICS.writeDataPoint(buildDataPoint(request, response, resolvedPath));
      } catch (err) {
        console.error("analytics: writeDataPoint failed:", err);
      }
    }

    return response;
  },
};

// Analytics Engine column layout. Columns are positional, and queries
// (pulumi/scripts/cf-analytics.ts) refer to them by position, so only
// append new fields at the end.
//
//   index1   client network: IPv4 /24 or IPv6 /48 (full IPs are never stored)
//   blob1    kind: deb | dists | key | html | other
//   blob2    request path (after "/" -> "/index.html")
//   blob3    package name     (deb only)
//   blob4    package version  (deb only)
//   blob5    architecture     (deb, or dists/.../binary-<arch>/...)
//   blob6    APT version parsed from User-Agent ("" when not APT)
//   blob7    User-Agent
//   blob8    country
//   blob9    Cloudflare colo
//   blob10   AS organization
//   blob11   HTTP method
//   blob12   CF-Cache-Status of the origin fetch
//   double1  HTTP status
//   double2  response body bytes (Content-Length; 0 for HEAD or when absent)
//   double3  ASN
function buildDataPoint(request, response, path) {
  const cf = request.cf || {};
  const userAgent = request.headers.get("User-Agent") || "";
  const { kind, pkg, version, arch } = classifyPath(path);
  const bytes = request.method === "HEAD" ? 0 : Number(response.headers.get("Content-Length")) || 0;
  return {
    indexes: [clientNetwork(request.headers.get("CF-Connecting-IP"))],
    blobs: [
      kind,
      truncate(path, 256),
      pkg,
      version,
      arch,
      aptVersion(userAgent),
      truncate(userAgent, 256),
      cf.country || "",
      cf.colo || "",
      truncate(cf.asOrganization || "", 128),
      request.method,
      response.headers.get("CF-Cache-Status") || "",
    ],
    doubles: [response.status, bytes, Number(cf.asn) || 0],
  };
}

const DEB_RE = /^\/pool\/.+\/([^/_]+)_([^/_]+)_([^/_]+)\.deb$/;
const BINARY_ARCH_RE = /^\/dists\/.+\/binary-([^/]+)\//;

function classifyPath(path) {
  const deb = DEB_RE.exec(path);
  if (deb) return { kind: "deb", pkg: deb[1], version: deb[2], arch: deb[3] };
  const none = { pkg: "", version: "", arch: "" };
  if (path.startsWith("/dists/")) {
    return { ...none, kind: "dists", arch: BINARY_ARCH_RE.exec(path)?.[1] ?? "" };
  }
  if (path === "/public.key") return { ...none, kind: "key" };
  if (path === "/index.html") return { ...none, kind: "html" };
  return { ...none, kind: "other" };
}

// "Debian APT-HTTP/1.3 (2.7.14)" -> "2.7.14"
function aptVersion(userAgent) {
  return /\bAPT-HTTP\/[\d.]+ \(([^)]+)\)/.exec(userAgent)?.[1] ?? "";
}

// Truncate the client IP to its network so that individual addresses are
// not stored: IPv4 -> /24, IPv6 -> /48.
function clientNetwork(ip) {
  if (!ip) return "";
  if (ip.includes(".")) {
    // IPv4, or IPv4-mapped IPv6 (::ffff:a.b.c.d)
    const octets = ip.slice(ip.lastIndexOf(":") + 1).split(".");
    return octets.length === 4 ? `${octets[0]}.${octets[1]}.${octets[2]}.0/24` : "";
  }
  // Only the first three groups matter, so groups after "::" can be ignored.
  const head = ip.split("::")[0];
  const groups = head ? head.split(":") : [];
  while (groups.length < 3) groups.push("0");
  const prefix = groups.slice(0, 3).map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""));
  return `${prefix.join(":")}::/48`;
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max) : s;
}
