// Run with `npm test` (node:test, no extra dependencies).
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

const ORIGIN = "https://my-bucket.s3.amazonaws.com/prefix";

let originalFetch;
let fetchCalls;
let originResponse;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  originResponse = () => new Response("body", { status: 200 });
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return originResponse();
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeRequest(path, { method = "GET", headers = {}, cf } = {}) {
  const request = new Request(`https://apt.example.com${path}`, { method, headers });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  return request;
}

function makeEnv() {
  const points = [];
  const env = {
    ORIGIN_BASE_URL: ORIGIN,
    ANALYTICS: { writeDataPoint: (p) => points.push(p) },
  };
  return { env, points };
}

describe("proxy", () => {
  it("maps a directory path to index.html on the origin", async () => {
    const res = await worker.fetch(makeRequest("/"), { ORIGIN_BASE_URL: `${ORIGIN}/` });
    assert.equal(res.status, 200);
    assert.equal(fetchCalls[0].url, `${ORIGIN}/index.html`);
  });

  it("rejects methods other than GET and HEAD without recording", async () => {
    const { env, points } = makeEnv();
    const res = await worker.fetch(makeRequest("/", { method: "POST" }), env);
    assert.equal(res.status, 405);
    assert.equal(fetchCalls.length, 0);
    assert.equal(points.length, 0);
  });
});

describe("analytics", () => {
  it("does nothing when the ANALYTICS binding is absent", async () => {
    const res = await worker.fetch(makeRequest("/public.key"), { ORIGIN_BASE_URL: ORIGIN });
    assert.equal(res.status, 200);
  });

  it("still returns the response when writeDataPoint throws", async () => {
    const env = {
      ORIGIN_BASE_URL: ORIGIN,
      ANALYTICS: { writeDataPoint: () => { throw new Error("boom"); } },
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await worker.fetch(makeRequest("/public.key"), env);
      assert.equal(res.status, 200);
    } finally {
      console.error = originalError;
    }
  });

  it("records a .deb download with client and package details", async () => {
    originResponse = () => new Response("x", {
      status: 200,
      headers: { "Content-Length": "61742830", "CF-Cache-Status": "MISS" },
    });
    const { env, points } = makeEnv();
    await worker.fetch(makeRequest("/pool/main/awscli-v2/awscli-v2_2.37.5-1_amd64.deb", {
      headers: { "User-Agent": "Debian APT-HTTP/1.3 (2.7.14)", "CF-Connecting-IP": "203.0.113.45" },
      cf: { country: "JP", colo: "NRT", asn: 2516, asOrganization: "KDDI" },
    }), env);

    assert.deepEqual(points, [{
      indexes: ["203.0.113.0/24"],
      blobs: [
        "deb",
        "/pool/main/awscli-v2/awscli-v2_2.37.5-1_amd64.deb",
        "awscli-v2",
        "2.37.5-1",
        "amd64",
        "2.7.14",
        "Debian APT-HTTP/1.3 (2.7.14)",
        "JP",
        "NRT",
        "KDDI",
        "GET",
        "MISS",
      ],
      doubles: [200, 61742830, 2516],
    }]);
  });

  it("classifies dists paths and extracts the binary architecture", async () => {
    const { env, points } = makeEnv();
    await worker.fetch(makeRequest("/dists/stable/main/binary-arm64/Packages.gz"), env);
    await worker.fetch(makeRequest("/dists/stable/InRelease"), env);
    assert.deepEqual(points.map((p) => [p.blobs[0], p.blobs[4]]), [["dists", "arm64"], ["dists", ""]]);
  });

  it("classifies the key, the index page and anything else", async () => {
    const { env, points } = makeEnv();
    for (const path of ["/public.key", "/", "/wp-login.php"]) {
      await worker.fetch(makeRequest(path), env);
    }
    assert.deepEqual(points.map((p) => [p.blobs[0], p.blobs[1]]), [
      ["key", "/public.key"],
      ["html", "/index.html"],
      ["other", "/wp-login.php"],
    ]);
  });

  it("leaves APT fields empty for non-APT clients", async () => {
    const { env, points } = makeEnv();
    await worker.fetch(makeRequest("/public.key", { headers: { "User-Agent": "curl/8.5.0" } }), env);
    assert.equal(points[0].blobs[5], "");
    assert.equal(points[0].blobs[6], "curl/8.5.0");
  });

  it("uses empty values when request.cf and the client IP are missing", async () => {
    const { env, points } = makeEnv();
    await worker.fetch(makeRequest("/public.key"), env);
    assert.deepEqual(points[0].indexes, [""]);
    assert.deepEqual(points[0].blobs.slice(7, 10), ["", "", ""]);
    assert.equal(points[0].doubles[2], 0);
  });

  it("records zero bytes for HEAD requests", async () => {
    originResponse = () => new Response(null, { status: 200, headers: { "Content-Length": "1234" } });
    const { env, points } = makeEnv();
    await worker.fetch(makeRequest("/public.key", { method: "HEAD" }), env);
    assert.deepEqual(points[0].doubles.slice(0, 2), [200, 0]);
    assert.equal(points[0].blobs[10], "HEAD");
  });

  it("records the origin status", async () => {
    originResponse = () => new Response(null, { status: 304 });
    const { env, points } = makeEnv();
    await worker.fetch(makeRequest("/dists/stable/InRelease"), env);
    assert.equal(points[0].doubles[0], 304);
  });

  it("truncates client IPs to their network", async () => {
    const cases = [
      ["198.51.100.7", "198.51.100.0/24"],
      ["::ffff:198.51.100.7", "198.51.100.0/24"],
      ["2001:DB8:0abc:5678::1", "2001:db8:abc::/48"],
      ["2001:db8::1", "2001:db8:0::/48"],
      ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8:0::/48"],
    ];
    for (const [ip, expected] of cases) {
      const { env, points } = makeEnv();
      await worker.fetch(makeRequest("/public.key", { headers: { "CF-Connecting-IP": ip } }), env);
      assert.deepEqual(points[0].indexes, [expected], ip);
    }
  });
});
