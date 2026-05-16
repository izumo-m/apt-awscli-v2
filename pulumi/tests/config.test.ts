import { describe, expect, it } from "vitest";
import {
    AppConfig,
    resolvePublicBaseUrl,
    validateAptArches,
    validateAptPackages,
    validateLambdaArch,
} from "../src/config";

describe("validateAptArches", () => {
    it("accepts a single supported arch", () => {
        expect(validateAptArches(["amd64"])).toEqual(["amd64"]);
    });

    it("accepts both supported arches", () => {
        expect(validateAptArches(["amd64", "arm64"])).toEqual(["amd64", "arm64"]);
    });

    it("rejects an unsupported arch", () => {
        expect(() => validateAptArches(["i386"])).toThrow(/Invalid aptArches/);
    });

    it("rejects a mixed array containing one bad arch", () => {
        expect(() => validateAptArches(["amd64", "ppc"])).toThrow(/Invalid aptArches/);
    });

    it("rejects a non-array value", () => {
        expect(() => validateAptArches("amd64")).toThrow(/must be a list/);
        expect(() => validateAptArches(null)).toThrow(/must be a list/);
        expect(() => validateAptArches(undefined)).toThrow(/must be a list/);
        expect(() => validateAptArches({ amd64: true })).toThrow(/must be a list/);
    });

    it("rejects non-string entries", () => {
        expect(() => validateAptArches([1, 2])).toThrow(/Invalid aptArches/);
        expect(() => validateAptArches([null])).toThrow(/Invalid aptArches/);
    });
});

describe("validateAptPackages", () => {
    it("accepts a string array", () => {
        expect(validateAptPackages(["aws-cli"])).toEqual(["aws-cli"]);
        expect(validateAptPackages(["aws-cli", "session-manager-plugin"]))
            .toEqual(["aws-cli", "session-manager-plugin"]);
    });

    it("does not validate package names (Lambda enforces those)", () => {
        // The pulumi-side validator only ensures shape — Lambda's Rust code
        // rejects unknown packages at startup. So an unfamiliar name passes
        // here.
        expect(validateAptPackages(["something-new"])).toEqual(["something-new"]);
    });

    it("rejects a non-array value", () => {
        expect(() => validateAptPackages("aws-cli")).toThrow(/must be a list/);
        expect(() => validateAptPackages(null)).toThrow(/must be a list/);
        expect(() => validateAptPackages(undefined)).toThrow(/must be a list/);
    });

    it("rejects non-string entries", () => {
        expect(() => validateAptPackages([1])).toThrow(/Invalid aptPackages entry/);
        expect(() => validateAptPackages([null])).toThrow(/Invalid aptPackages entry/);
    });
});

describe("validateLambdaArch", () => {
    it("accepts x86_64", () => {
        expect(validateLambdaArch("x86_64")).toBe("x86_64");
    });

    it("accepts arm64", () => {
        expect(validateLambdaArch("arm64")).toBe("arm64");
    });

    it("rejects the APT spelling amd64 (Lambda needs x86_64)", () => {
        expect(() => validateLambdaArch("amd64")).toThrow(/Invalid lambdaArch/);
    });

    it("rejects unsupported arches", () => {
        expect(() => validateLambdaArch("ppc64")).toThrow(/Invalid lambdaArch/);
    });
});

describe("resolvePublicBaseUrl", () => {
    // Minimal AppConfig fragments — only the fields the function reads. Cast
    // through Partial so we don't have to enumerate every unrelated field.
    const make = (overrides: Partial<AppConfig>): AppConfig =>
        ({ cloudflareEnabled: false, ...overrides } as AppConfig);

    it("returns undefined when Cloudflare is disabled", () => {
        expect(resolvePublicBaseUrl(make({ cloudflareEnabled: false }))).toBeUndefined();
    });

    it("returns the explicit publicBaseUrl when set", () => {
        expect(resolvePublicBaseUrl(make({
            cloudflareEnabled: true,
            cloudflarePublicBaseUrl: "https://example.com",
        }))).toBe("https://example.com");
    });

    it("strips trailing slashes from the explicit publicBaseUrl", () => {
        expect(resolvePublicBaseUrl(make({
            cloudflareEnabled: true,
            cloudflarePublicBaseUrl: "https://example.com///",
        }))).toBe("https://example.com");
    });

    it("derives from customDomain when publicBaseUrl is unset", () => {
        expect(resolvePublicBaseUrl(make({
            cloudflareEnabled: true,
            cloudflareCustomDomain: "example.com",
        }))).toBe("https://example.com");
    });

    it("prefers publicBaseUrl over customDomain when both are set", () => {
        expect(resolvePublicBaseUrl(make({
            cloudflareEnabled: true,
            cloudflarePublicBaseUrl: "https://from-base.example",
            cloudflareCustomDomain: "from-domain.example",
        }))).toBe("https://from-base.example");
    });

    it("returns undefined when neither is set even though Cloudflare is enabled", () => {
        expect(resolvePublicBaseUrl(make({ cloudflareEnabled: true }))).toBeUndefined();
    });
});
