import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";

import worker, { buildMeetingSignPdf } from "../worker.js";

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

function sampleMeeting() {
  return {
    id: "meeting-pdf-1",
    title: "Acreditaciones y competencias profesionales",
    date: "2099-10-23",
    time: "09:30",
    duration: 90,
    room: "salon-actos",
    modality: "presencial",
    notes: "Jornada informativa para empresas y profesionales.",
    organizer_name: "Usuario de prueba",
  };
}

test("genera un PDF A4 válido para el cartel de reserva", async () => {
  const bytes = await buildMeetingSignPdf(sampleMeeting());

  assert.ok(bytes instanceof Uint8Array);
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), "%PDF-");
  assert.match(Buffer.from(bytes).toString("latin1"), /\/Subtype\s*\/Image/);
  assert.ok(bytes.byteLength > 1_000);
  const document = await PDFDocument.load(bytes);
  const { width, height } = document.getPage(0).getSize();
  assert.ok(Math.abs(width - 595.276) < 0.01);
  assert.ok(Math.abs(height - 841.89) < 0.01);
});

test("genera el cartel aunque el título contenga emojis", async () => {
  const bytes = await buildMeetingSignPdf({
    ...sampleMeeting(),
    title: "Reunión de innovación 🚀",
    notes: "Presentación — turno de preguntas ✅",
  });

  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), "%PDF-");
});

test("la ruta protegida devuelve el cartel PDF de una reunión", async () => {
  const env = {
    AUTH_SECRET,
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({ meetings: JSON.stringify([sampleMeeting()]) }),
  };
  const cookie = await createSessionCookie();
  const response = await worker.fetch(new Request(
    "https://reuniones.example.test/api/meetings/meeting-pdf-1/sign.pdf",
    { headers: { cookie } },
  ), env);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.match(response.headers.get("content-disposition"), /^inline;/);
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
});

test("al crear una reserva devuelve la ruta del cartel PDF", async () => {
  const env = {
    AUTH_SECRET,
    MEETING_NOTIFICATIONS_ENABLED: "false",
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({ meetings: "[]" }),
  };
  const cookie = await createSessionCookie();
  const response = await worker.fetch(new Request("https://reuniones.example.test/api/meetings", {
    method: "POST",
    headers: {
      cookie,
      origin: "https://reuniones.example.test",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      title: "Reserva con cartel",
      date: "2099-10-23",
      time: "12:00",
      duration: "60",
      room: "sala-pleno",
      modality: "presencial",
    }),
  }), env);
  const body = await response.json();

  assert.equal(body.ok, true);
  assert.match(body.sign_url, /^\/api\/meetings\/.+\/sign\.pdf$/);
});
