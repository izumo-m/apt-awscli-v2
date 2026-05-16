import { describe, expect, it } from "vitest";
import { deriveOriginUrl } from "../src/cloudflare";

describe("deriveOriginUrl", () => {
    it("returns origin without path for bucket only", () => {
        expect(deriveOriginUrl("s3://my-bucket")).toBe("https://my-bucket.s3.amazonaws.com");
    });

    it("ignores a single trailing slash on the bucket form", () => {
        expect(deriveOriginUrl("s3://my-bucket/")).toBe("https://my-bucket.s3.amazonaws.com");
    });

    it("appends the prefix", () => {
        expect(deriveOriginUrl("s3://my-bucket/apt")).toBe("https://my-bucket.s3.amazonaws.com/apt");
    });

    it("strips a single trailing slash on the prefix", () => {
        expect(deriveOriginUrl("s3://my-bucket/apt/")).toBe("https://my-bucket.s3.amazonaws.com/apt");
    });

    it("strips repeated trailing slashes on the prefix", () => {
        expect(deriveOriginUrl("s3://my-bucket/apt///")).toBe("https://my-bucket.s3.amazonaws.com/apt");
    });

    it("preserves nested prefixes", () => {
        expect(deriveOriginUrl("s3://my-bucket/a/b/c/")).toBe("https://my-bucket.s3.amazonaws.com/a/b/c");
    });

    it("throws on a non-s3 URI", () => {
        expect(() => deriveOriginUrl("https://my-bucket.s3.amazonaws.com/apt")).toThrow(/Invalid s3Uri/);
    });
});
