import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.js";

const AUTH_SECRET = "test-secret-only";

function createKv(initialEntries = {}) {
  const entries = new Map(Object.entries(initialEntries));
  return {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async put(key, value) {
      entries.set(key, value);
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

function createAuthDb() {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return {
                display_name: "Usuario de prueba",
                email: "test@example.test",
                role: "user",
                application_role: "user",
              };
            },
          };
        },
      };
    },
  };
}

async function createSessionCookie() {
  const payload = Buffer.from(JSON.stringify({
    username: "Usuario de prueba",
    role: "usuario",
    centralUserId: 1,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  )).toString("base64url");
  return `reuniones_session=${payload}.${signature}`;
}

function historyRecord() {
  return {
    id: "history-1",
    title: "Reunión finalizada",
    date: "2026-09-01",
    time: "10:00",
    duration: 60,
    url: "https://meet.example.test/history-1",
    notes: "No debe salir en la API",
    completed_at: "2026-09-01T09:00:00.000Z",
  };
}

test("la API pública de pantalla no expone el historial", async () => {
  const env = {
    AUTH_SECRET,
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({
      meetings: "[]",
      meeting_history: JSON.stringify([historyRecord()]),
    }),
  };

  const response = await worker.fetch(new Request("https://reuniones.example.test/api-meeting"), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.has_meeting, false);
  assert.equal("history" in body, false);
});

test("la agenda autenticada devuelve cinco reuniones como máximo y sin notas", async () => {
  const records = Array.from({ length: 6 }, (_, index) => ({
    ...historyRecord(),
    id: `history-${index}`,
    completed_at: `2026-09-0${index + 1}T09:00:00.000Z`,
  }));
  const env = {
    AUTH_SECRET,
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({
      meetings: "[]",
      meeting_history: JSON.stringify(records),
    }),
  };
  const cookie = await createSessionCookie();

  const response = await worker.fetch(new Request("https://reuniones.example.test/api/meetings", {
    headers: { cookie },
  }), env);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.history.length, 5);
  assert.equal(body.history[0].id, "history-5");
  assert.equal(body.history[0].url, "https://meet.example.test/history-1");
  assert.equal("notes" in body.history[0], false);
});
