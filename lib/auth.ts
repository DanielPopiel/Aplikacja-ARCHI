export const AUTH_COOKIE = "archi_auth";

/**
 * Session token derived from APP_PASSWORD (Edge-compatible, Web Crypto).
 * Stable for a given password, so no server-side session store is needed.
 */
export async function sessionTokenFor(password: string): Promise<string> {
  const data = new TextEncoder().encode(`archi-session-v1:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
