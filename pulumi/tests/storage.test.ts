import { describe, expect, it } from "vitest";
import { parseS3Uri } from "../src/storage";

describe("parseS3Uri", () => {
    it("parses bucket with trailing slash and no prefix", () => {
        expect(parseS3Uri("s3://my-bucket/")).toEqual({ bucket: "my-bucket", prefix: "" });
    });

    it("parses bucket without trailing slash", () => {
        expect(parseS3Uri("s3://my-bucket")).toEqual({ bucket: "my-bucket", prefix: "" });
    });

    it("parses bucket with prefix", () => {
        expect(parseS3Uri("s3://my-bucket/apt/")).toEqual({ bucket: "my-bucket", prefix: "apt/" });
    });

    it("normalizes missing trailing slash on prefix", () => {
        expect(parseS3Uri("s3://my-bucket/apt")).toEqual({ bucket: "my-bucket", prefix: "apt/" });
    });

    it("parses nested prefix", () => {
        expect(parseS3Uri("s3://my-bucket/a/b/c/")).toEqual({ bucket: "my-bucket", prefix: "a/b/c/" });
    });

    it("parses single-character prefix", () => {
        expect(parseS3Uri("s3://my-bucket/x/")).toEqual({ bucket: "my-bucket", prefix: "x/" });
    });

    it("throws on non-s3 scheme", () => {
        expect(() => parseS3Uri("https://example.com/apt/")).toThrow(/Invalid S3 URI/);
    });

    it("throws on a bare string", () => {
        expect(() => parseS3Uri("not-a-url")).toThrow(/Invalid S3 URI/);
    });

    it("throws on empty input", () => {
        expect(() => parseS3Uri("")).toThrow(/Invalid S3 URI/);
    });
});
