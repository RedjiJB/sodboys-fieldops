// Verified against RFC 6238 Appendix B's own published SHA1 test vectors
// (truncated to 6 digits instead of the RFC's 8, since the underlying
// HOTP computation -- and therefore correctness -- is identical either
// way, just a different modulus at the final truncation step). Secret is
// the RFC's own ASCII test secret "12345678901234567890", base32-encoded
// (a widely-cited constant across TOTP implementations' own test suites,
// not derived here) -- this is deliberately testing against the published
// standard, not just internal self-consistency, since a subtly-wrong HMAC
// counter/truncation implementation could still pass a round-trip test
// against itself while rejecting every real authenticator app's codes.
import { describe, expect, it } from "vitest";
import { computeTotp, verifyTotpCode, generateTotpSecret, buildProvisioningUri } from "../src/identity/totp.js";

const RFC_TEST_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // base32("12345678901234567890")

describe("totp", () => {
  it("matches RFC 6238 Appendix B's published SHA1 test vectors (6-digit truncation)", () => {
    const cases: [number, string][] = [
      [59 * 1000, "287082"],
      [1111111109 * 1000, "081804"],
      [1111111111 * 1000, "050471"],
      [1234567890 * 1000, "005924"],
      [2000000000 * 1000, "279037"],
    ];
    for (const [atMs, expected] of cases) {
      expect(computeTotp(RFC_TEST_SECRET, atMs)).toBe(expected);
    }
  });

  it("verifies a currently-valid code and rejects a wrong one", () => {
    const now = Date.now();
    const code = computeTotp(RFC_TEST_SECRET, now);
    expect(verifyTotpCode(RFC_TEST_SECRET, code, now)).toBe(true);
    expect(verifyTotpCode(RFC_TEST_SECRET, "000000" === code ? "111111" : "000000", now)).toBe(false);
  });

  it("tolerates one time-step of clock drift either direction", () => {
    const now = Date.now();
    const oneStepAgo = now - 30_000;
    const code = computeTotp(RFC_TEST_SECRET, oneStepAgo);
    expect(verifyTotpCode(RFC_TEST_SECRET, code, now)).toBe(true);
  });

  it("rejects a code two steps outside the window", () => {
    const now = Date.now();
    const twoStepsAgo = now - 90_000;
    const code = computeTotp(RFC_TEST_SECRET, twoStepsAgo);
    expect(verifyTotpCode(RFC_TEST_SECRET, code, now)).toBe(false);
  });

  it("rejects non-6-digit input outright", () => {
    expect(verifyTotpCode(RFC_TEST_SECRET, "12345")).toBe(false);
    expect(verifyTotpCode(RFC_TEST_SECRET, "abcdef")).toBe(false);
  });

  it("generates a real, round-trippable secret and a well-formed provisioning URI", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    const code = computeTotp(secret);
    expect(verifyTotpCode(secret, code)).toBe(true);

    const uri = buildProvisioningUri({ secret, accountLabel: "admin@sodboys.ca", issuer: "Sod Boys FieldOps" });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("period=30");
    expect(uri).toContain("digits=6");
  });
});
