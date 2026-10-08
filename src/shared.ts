// Helpers shared by the client and the component. Secrets are only ever
// generated in actions / HTTP actions (real randomness); the component's
// mutations see SHA-256 hashes, never plaintext tokens.

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return toHex(new Uint8Array(digest));
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return base64Url(new Uint8Array(digest));
}

export function randomToken(prefix: string, bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return `${prefix}${base64Url(buf)}`;
}

export function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export const TOKEN_PREFIX = {
  access: "mcp_at_",
  refresh: "mcp_rt_",
  apiKey: "mcp_sk_",
  code: "mcp_ac_",
} as const;
