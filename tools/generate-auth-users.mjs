import { webcrypto } from "node:crypto";

const users = parseUsers(process.argv.slice(2));

if (users.length === 0) {
  console.error("Uso:");
  console.error("  npm run auth:generate -- admin=TuClave usuario=OtraClave");
  process.exit(1);
}

const authUsers = [];

for (const user of users) {
  authUsers.push({
    username: user.username,
    role: user.username === "admin" ? "admin" : "usuario",
    passwordHash: await hashPassword(user.password),
  });
}

const authSecret = base64UrlEncode(webcrypto.getRandomValues(new Uint8Array(32)));

console.log("AUTH_SECRET:");
console.log(authSecret);
console.log("");
console.log("AUTH_USERS:");
console.log(JSON.stringify(authUsers));

function parseUsers(args) {
  return args
    .map((arg) => {
      const separator = arg.indexOf("=");
      if (separator === -1) return null;
      const username = arg.slice(0, separator).trim();
      const password = arg.slice(separator + 1);
      if (!username || !password) return null;
      return { username, password };
    })
    .filter(Boolean);
}

async function hashPassword(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const passwordBytes = new TextEncoder().encode(password);
  const payload = new Uint8Array(salt.length + passwordBytes.length);
  payload.set(salt, 0);
  payload.set(passwordBytes, salt.length);
  const hash = await webcrypto.subtle.digest("SHA-256", payload);
  return `sha256$${base64UrlEncode(salt)}$${base64UrlEncode(new Uint8Array(hash))}`;
}

function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
