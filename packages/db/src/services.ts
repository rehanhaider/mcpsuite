/**
 * Server-side service implementations injected into the operation catalog:
 * password hashing (scrypt), MCP API-key generation, and CSV parse/stringify.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import type { AuthServices, CsvServices } from "@emcp/core";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString("hex");
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, salt, expected] = parts as [string, string, string, string, string, string];
  const hash = scryptSync(password, salt, expected.length / 2, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  }).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Unambiguous alphabet (no 0/O, 1/l/I) for one-time passwords. */
const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 16): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[bytes[i]! % PASSWORD_ALPHABET.length];
  return out;
}

/** API keys look like `emcp_<40 hex>`; we store only the SHA-256 hash. */
export function generateMcpToken(): { token: string; hash: string; prefix: string } {
  const token = `emcp_${randomBytes(20).toString("hex")}`;
  return { token, hash: sha256Hex(token), prefix: token.slice(0, 12) };
}

export const authServices: AuthServices = {
  hashPassword,
  generatePassword: () => generatePassword(),
  generateMcpToken,
};

export const csvServices: CsvServices = {
  parse(csv: string): Array<Record<string, string>> {
    return parse(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    }) as Array<Record<string, string>>;
  },
  stringify(rows: Array<Record<string, unknown>>): string {
    if (rows.length === 0) return "";
    return stringify(rows, { header: true }) as string;
  },
};
