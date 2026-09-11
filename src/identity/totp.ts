// TOTP (RFC 6238, built on HOTP/RFC 4226) for admin MFA -- Node's built-in
// crypto.createHmac only, no new dependency, same posture as
// passwords.ts's own scrypt choice ("a well-regarded, standard [mechanism]
// and needs nothing new"). Deliberately not a QR-image-generating library
// either: buildProvisioningUri returns the real otpauth:// URI text, which
// every authenticator app accepts via manual entry or by encoding it into
// a QR code client-side (e.g. a `qrcode.react`-style component in the
// vendored frontend, if that polish is ever added) -- generating the QR
// bitmap itself server-side isn't needed for the protocol to work.
import { createHmac, randomBytes } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SECRET_BYTES = 20; // 160 bits, RFC 4226's recommended HOTP secret length
const TIME_STEP_SECONDS = 30;
const CODE_DIGITS = 6;
// Tolerate one step of clock drift either side -- a real, common need
// (phone/server clocks are rarely perfectly synced), not a security
// weakening: it widens the valid window from 30s to 90s, still narrow
// enough that a leaked code is useless within minutes.
const VERIFY_WINDOW_STEPS = 1;

function base32Encode(buffer: Buffer): string {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder > 0) {
    const lastChunk = bits.slice(bits.length - remainder).padEnd(5, "0");
    output += BASE32_ALPHABET[parseInt(lastChunk, 2)];
  }
  return output;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) continue;
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

// otpauth://totp/<issuer>:<account>?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30
// -- the standard URI form every authenticator app (Google Authenticator,
// Authy, 1Password, etc.) recognizes for both QR-scan and manual entry.
export function buildProvisioningUri(args: { secret: string; accountLabel: string; issuer: string }): string {
  const label = encodeURIComponent(`${args.issuer}:${args.accountLabel}`);
  const params = new URLSearchParams({
    secret: args.secret,
    issuer: args.issuer,
    algorithm: "SHA1",
    digits: String(CODE_DIGITS),
    period: String(TIME_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function computeCodeForCounter(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = binary % 10 ** CODE_DIGITS;
  return code.toString().padStart(CODE_DIGITS, "0");
}

export function computeTotp(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / TIME_STEP_SECONDS);
  return computeCodeForCounter(secret, counter);
}

// Constant-time-ish by comparing every candidate window regardless of an
// early match (no early-return on the first hit) -- a real, if modest,
// defense against timing analysis on which window step matched, matching
// this project's general instinct (see passwords.ts's own
// timingSafeEqual use) even though TOTP's short validity window already
// bounds the practical value of such an attack.
export function verifyTotpCode(secret: string, code: string, atMs: number = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(atMs / 1000 / TIME_STEP_SECONDS);
  let matched = false;
  for (let delta = -VERIFY_WINDOW_STEPS; delta <= VERIFY_WINDOW_STEPS; delta++) {
    const candidate = computeCodeForCounter(secret, counter + delta);
    if (candidate === code) matched = true;
  }
  return matched;
}
