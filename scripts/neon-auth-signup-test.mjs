/**
 * Proves Neon Managed Better Auth email signup + session read.
 * Loads .env; never prints secrets or passwords.
 */
import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnv(".env");
loadEnv(".env.local");

const base = (process.env.NEON_AUTH_BASE_URL || "").replace(/\/+$/, "");
if (!base) {
  console.error("FAIL: NEON_AUTH_BASE_URL missing");
  process.exit(1);
}

const stamp = Date.now().toString(36);
const email = `neon-test-${stamp}@example.com`;
const password = `T${randomBytes(12).toString("base64url")}!a1`;
const name = `Neon Test ${stamp}`;

function collectCookies(res, jar) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const pair = c.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const single = res.headers.get("set-cookie");
  if (single && raw.length === 0) {
    for (const part of single.split(/,(?=[^;]+?=)/)) {
      const pair = part.split(";")[0].trim();
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function postJson(path, body, jar) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      cookie: cookieHeader(jar),
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  collectCookies(res, jar);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

async function getSession(jar) {
  const res = await fetch(`${base}/get-session`, {
    headers: {
      origin: "http://localhost:3000",
      cookie: cookieHeader(jar),
    },
  });
  collectCookies(res, jar);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const jar = new Map();

console.log("Signing up test user…");
const signup = await postJson("/sign-up/email", { email, password, name }, jar);
if (signup.status >= 400 || signup.json?.error || signup.json?.code) {
  console.error("FAIL: signup", signup.status, signup.json?.message || signup.json?.error || signup.json);
  process.exit(1);
}

const userFromSignup = signup.json?.user || signup.json?.data?.user || null;
console.log("Signup OK", {
  status: signup.status,
  email,
  userId: userFromSignup?.id || "(in session)",
  name: userFromSignup?.name || name,
});

console.log("Reading session…");
let session = await getSession(jar);
let user = session.json?.user || session.json?.session?.user || session.json?.data?.user || null;

if (!user) {
  console.log("No session yet; signing in…");
  const signin = await postJson("/sign-in/email", { email, password }, jar);
  if (signin.status >= 400 || signin.json?.error || signin.json?.code) {
    console.error("FAIL: sign-in", signin.status, signin.json?.message || signin.json?.error || signin.json);
    process.exit(1);
  }
  session = await getSession(jar);
  user = session.json?.user || session.json?.session?.user || session.json?.data?.user || signin.json?.user || null;
}

if (!user?.email) {
  console.error("FAIL: could not read current user", session.status, session.json);
  process.exit(1);
}

console.log("Current user OK", {
  id: user.id,
  email: user.email,
  name: user.name,
  emailVerified: user.emailVerified ?? null,
});
console.log("PASS");
