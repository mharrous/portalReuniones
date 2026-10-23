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
    async put(key, value, options = {}) {
      if (options.expirationTtl && options.expirationTtl < 60) {
        throw new Error("expirationTtl must be at least 60 seconds");
      }
      entries.set(key, value);
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

function createAuthDb() {
  const notificationCooldowns = new Set();
  return {
    async exec(sql) {
      if (String(sql).includes("CREATE TABLE")) {
        throw new Error("D1_EXEC_ERROR: incomplete input");
      }
      return { count: 0 };
    },
    prepare(sql) {
      return {
        async run() {
          return { success: true };
        },
        bind(...values) {
          return {
            async run() {
              return { success: true };
            },
            async first() {
              if (sql.includes("meeting_email_cooldowns")) {
                const scope = String(values[0]);
                if (notificationCooldowns.has(scope)) return null;
                notificationCooldowns.add(scope);
                return { scope };
              }
              return {
                display_name: "Usuario de prueba",
                email: "test@example.test",
                role: "user",
                application_role: "user",
              };
            },
            async all() {
              return { results: [{ email: "test@example.test" }] };
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

test("el formulario autenticado muestra las dos modalidades", async () => {
  const env = {
    AUTH_SECRET,
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({ meetings: "[]" }),
  };
  const cookie = await createSessionCookie();
  const response = await worker.fetch(new Request("https://reuniones.example.test/add.php", {
    headers: { cookie },
  }), env);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /name="modality"/);
  assert.match(html, /value="presencial"/);
  assert.match(html, /value="videoconferencia"/);
});

test("la API permite el mismo horario en salas distintas y bloquea solapes por sala", async () => {
  const env = {
    AUTH_SECRET,
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({ meetings: "[]" }),
  };
  const cookie = await createSessionCookie();

  async function createMeeting(room, title) {
    const response = await worker.fetch(new Request("https://reuniones.example.test/api/meetings", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://reuniones.example.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        title,
        date: "2099-10-20",
        time: "10:00",
        duration: "60",
        room,
        url: "https://meet.example.test/reserva",
      }),
    }), env);

    return response.json();
  }

  const pleno = await createMeeting("sala-pleno", "Reunión en Pleno");
  const orientacion = await createMeeting("sala-orientacion", "Reunión en Orientación");
  const salonActos = await createMeeting("salon-actos", "Evento en Salón de Actos");
  const plenoDuplicado = await createMeeting("sala-pleno", "Reunión duplicada");

  assert.equal(pleno.ok, true);
  assert.equal(orientacion.ok, true);
  assert.equal(salonActos.ok, true);
  assert.equal(plenoDuplicado.ok, false);
  assert.match(plenoDuplicado.message, /Sala Pleno ya está ocupada/);
});

test("la API permite reuniones presenciales sin enlace y exige enlace para videoconferencias", async () => {
  const env = {
    AUTH_SECRET,
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({ meetings: "[]" }),
  };
  const cookie = await createSessionCookie();

  async function createMeeting(modality, url, time) {
    const response = await worker.fetch(new Request("https://reuniones.example.test/api/meetings", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://reuniones.example.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        title: "Reserva de prueba",
        date: "2099-10-21",
        time,
        duration: "60",
        room: "sala-pleno",
        modality,
        url,
      }),
    }), env);

    return response.json();
  }

  const presencial = await createMeeting("presencial", "", "09:00");
  const videoSinEnlace = await createMeeting("videoconferencia", "", "11:00");

  assert.equal(presencial.ok, true);
  assert.equal(videoSinEnlace.ok, false);
  assert.match(videoSinEnlace.message, /enlace/i);
});

test("rechaza cambios enviados desde un origen distinto al portal", async () => {
  const env = {
    AUTH_SECRET,
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({ meetings: "[]" }),
  };
  const cookie = await createSessionCookie();
  const response = await worker.fetch(new Request("https://reuniones.example.test/api/meetings", {
    method: "POST",
    headers: {
      cookie,
      origin: "https://aplicacion-maliciosa.example.test",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      title: "Reserva no autorizada",
      date: "2099-10-21",
      time: "13:00",
      duration: "60",
      room: "sala-pleno",
      modality: "presencial",
      url: "",
    }),
  }), env);
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.ok, false);
  assert.deepEqual(JSON.parse(await env.MEETINGS_KV.get("meetings")), []);
});

test("una reserva envía un correo con copia oculta mediante Microsoft Graph", async () => {
  const graphRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    graphRequests.push({ url: String(url), options });
    if (String(url).includes("/oauth2/v2.0/token")) {
      return Response.json({ access_token: "graph-access-token", expires_in: 3600 });
    }
    return new Response(null, { status: 202 });
  };

  const env = {
    AUTH_SECRET,
    MICROSOFT_TENANT_ID: "tenant-id",
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    MICROSOFT_SENDER_EMAIL: "reuniones@example.test",
    MICROSOFT_RECIPIENT_EMAIL: "trabajadores_camara@example.test",
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({ meetings: "[]" }),
  };
  const cookie = await createSessionCookie();

  try {
    const response = await worker.fetch(new Request("https://reuniones.example.test/api/meetings", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://reuniones.example.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        title: "Reunión notificada",
        date: "2099-10-22",
        time: "12:00",
        duration: "60",
        room: "sala-orientacion",
        modality: "presencial",
        url: "",
      }),
    }), env);
    const body = await response.json();

    assert.equal(body.ok, true);
    assert.equal(body.notification.sent, true);
    assert.equal(body.notification.recipients, 1);
    assert.equal(graphRequests.length, 2);
    assert.match(graphRequests[0].url, /tenant-id\/oauth2\/v2\.0\/token$/);
    assert.match(String(graphRequests[0].options.body), /grant_type=client_credentials/);
    assert.match(String(graphRequests[0].options.body), /client_secret=client-secret/);
    assert.match(graphRequests[1].url, /users\/reuniones%40example\.test\/sendMail$/);
    assert.equal(graphRequests[1].options.headers.Authorization, "Bearer graph-access-token");
    const graphMessage = JSON.parse(graphRequests[1].options.body);
    assert.deepEqual(graphMessage.message.bccRecipients, [{ emailAddress: { address: "trabajadores_camara@example.test" } }]);
    assert.match(body.message, /destinatario configurado/i);
    assert.match(graphMessage.message.body.content, /Sala Orientación/);
    assert.match(graphMessage.message.body.content, /Presencial/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("no envía correos cuando los avisos están pausados", async () => {
  const originalFetch = globalThis.fetch;
  let graphRequests = 0;
  globalThis.fetch = async () => {
    graphRequests += 1;
    return new Response(null, { status: 202 });
  };

  const env = {
    AUTH_SECRET,
    MEETING_NOTIFICATIONS_ENABLED: "false",
    MICROSOFT_TENANT_ID: "tenant-id",
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    MICROSOFT_SENDER_EMAIL: "reuniones@example.test",
    MICROSOFT_RECIPIENT_EMAIL: "avisos_salas@example.test",
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({ meetings: "[]" }),
  };
  const cookie = await createSessionCookie();

  try {
    const response = await worker.fetch(new Request("https://reuniones.example.test/api/meetings", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://reuniones.example.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        title: "Reserva sin aviso",
        date: "2099-10-23",
        time: "12:00",
        duration: "60",
        room: "sala-pleno",
        modality: "presencial",
        url: "",
      }),
    }), env);
    const body = await response.json();

    assert.equal(body.ok, true);
    assert.equal(body.notification.sent, false);
    assert.equal(body.notification.paused, true);
    assert.match(body.message, /avisos por correo pausados/i);
    assert.equal(graphRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("evita avisos repetidos del mismo usuario durante el periodo de seguridad", async () => {
  const graphRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    graphRequests.push({ url: String(url), options });
    if (String(url).includes("/oauth2/v2.0/token")) {
      return Response.json({ access_token: "graph-access-token", expires_in: 3600 });
    }
    return new Response(null, { status: 202 });
  };
  const env = {
    AUTH_SECRET,
    MICROSOFT_TENANT_ID: "tenant-id",
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    MICROSOFT_SENDER_EMAIL: "reuniones@example.test",
    MICROSOFT_RECIPIENT_EMAIL: "trabajadores_camara@example.test",
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({ meetings: "[]" }),
  };
  const cookie = await createSessionCookie();

  async function reserve(time) {
    const response = await worker.fetch(new Request("https://reuniones.example.test/api/meetings", {
      method: "POST",
      headers: { cookie, origin: "https://reuniones.example.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        title: `Reserva ${time}`,
        date: "2099-10-26",
        time,
        duration: "60",
        room: "sala-pleno",
        modality: "presencial",
        url: "",
      }),
    }), env);
    return response.json();
  }

  try {
    const first = await reserve("09:00");
    const second = await reserve("11:00");

    assert.equal(first.notification.sent, true);
    assert.equal(second.notification.sent, false);
    assert.match(second.notification.message, /evitar envíos repetidos/i);
    assert.equal(graphRequests.filter((request) => request.url.includes("/sendMail")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Microsoft Graph reintenta un envío limitado temporalmente", async () => {
  const graphRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    graphRequests.push({ url: String(url), options });
    if (String(url).includes("/oauth2/v2.0/token")) {
      return Response.json({ access_token: "graph-access-token", expires_in: 3600 });
    }
    const sendAttempt = graphRequests.filter((request) => request.url.includes("/sendMail")).length;
    if (sendAttempt === 1) {
      return Response.json({ error: { code: "TooManyRequests" } }, {
        status: 429,
        headers: { "Retry-After": "0" },
      });
    }
    return new Response(null, { status: 202 });
  };

  const env = {
    AUTH_SECRET,
    MICROSOFT_TENANT_ID: "tenant-id",
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    MICROSOFT_SENDER_EMAIL: "reuniones@example.test",
    MICROSOFT_RECIPIENT_EMAIL: "trabajadores_camara@example.test",
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({ meetings: "[]" }),
  };
  const cookie = await createSessionCookie();

  try {
    const response = await worker.fetch(new Request("https://reuniones.example.test/api/meetings", {
      method: "POST",
      headers: { cookie, origin: "https://reuniones.example.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        title: "Reserva con reintento",
        date: "2099-10-24",
        time: "09:00",
        duration: "60",
        room: "sala-pleno",
        modality: "presencial",
        url: "",
      }),
    }), env);
    const body = await response.json();

    assert.equal(body.notification.sent, true);
    assert.equal(graphRequests.filter((request) => request.url.includes("/sendMail")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("no solicita tokens si el correo remitente no es válido", async () => {
  let graphRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    graphRequests += 1;
    return Response.json({ access_token: "unexpected-token" });
  };
  const env = {
    AUTH_SECRET,
    MICROSOFT_TENANT_ID: "tenant-id",
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    MICROSOFT_SENDER_EMAIL: "correo-no-valido",
    MICROSOFT_RECIPIENT_EMAIL: "trabajadores_camara@example.test",
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({ meetings: "[]" }),
  };
  const cookie = await createSessionCookie();

  try {
    const response = await worker.fetch(new Request("https://reuniones.example.test/api/meetings", {
      method: "POST",
      headers: { cookie, origin: "https://reuniones.example.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        title: "Reserva sin remitente válido",
        date: "2099-10-25",
        time: "09:00",
        duration: "60",
        room: "sala-pleno",
        modality: "presencial",
        url: "",
      }),
    }), env);
    const body = await response.json();

    assert.equal(body.ok, true);
    assert.equal(body.notification.sent, false);
    assert.equal(graphRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("la reserva permanece guardada si Microsoft Graph rechaza el correo", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/oauth2/v2.0/token")) {
      return Response.json({ access_token: "graph-access-token", expires_in: 3600 });
    }
    return Response.json({ error: { code: "ErrorAccessDenied" } }, { status: 403 });
  };
  const env = {
    AUTH_SECRET,
    MICROSOFT_TENANT_ID: "tenant-id",
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    MICROSOFT_SENDER_EMAIL: "reuniones@example.test",
    MICROSOFT_RECIPIENT_EMAIL: "trabajadores_camara@example.test",
    PORTAL_AUTH_DB: createAuthDb(),
    MEETINGS_KV: createKv({ meetings: "[]" }),
  };
  const cookie = await createSessionCookie();

  try {
    const response = await worker.fetch(new Request("https://reuniones.example.test/api/meetings", {
      method: "POST",
      headers: { cookie, origin: "https://reuniones.example.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        title: "Reserva conservada",
        date: "2099-10-23",
        time: "09:00",
        duration: "60",
        room: "sala-pleno",
        modality: "presencial",
        url: "",
      }),
    }), env);
    const body = await response.json();
    const meetings = JSON.parse(await env.MEETINGS_KV.get("meetings"));

    assert.equal(body.ok, true);
    assert.equal(body.notification.sent, false);
    assert.match(body.notification.message, /reserva sí quedó guardada/i);
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0].title, "Reserva conservada");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
