const ROOM_NAME = "Sala de reuniones";
const TZ = "Europe/Madrid";
const DEFAULT_DURATION = 60;
const MEETINGS_KEY = "meetings";
const DOCK_KEY = "dock_state";
const AUTH_USERS_KEY = "auth_users";
const SESSION_COOKIE = "reuniones_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const LOGIN_PATH = "/login";
const LOGOUT_PATH = "/logout";
const CURRENT_APP_CODE = "reuniones";

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/health") {
        return new Response("ok", {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }

      if (path === "/api/auth/portal" && request.method === "GET") {
        return handlePortalLogin(url, env);
      }

      const configError = getAuthConfigError(env);
      if (configError) {
        return htmlResponse(renderLoginSetupError(configError), 503);
      }

      if (path === LOGIN_PATH) {
        if (request.method === "GET") {
          const sessionUser = await getSessionUser(request, env);
          if (sessionUser) return redirectResponse("/");
          return htmlResponse(renderLogin({ next: url.searchParams.get("next") || "/" }));
        }

        if (request.method === "POST") {
          return handleLogin(request, env);
        }

        return jsonResponse({ ok: false, message: "Método no permitido." }, 405);
      }

      if (path === LOGOUT_PATH) {
        return redirectResponse(LOGIN_PATH, { "set-cookie": clearSessionCookie() });
      }

      const isDockApi = path === "/api-dock.php" || path === "/api-dock";
      const isMeetingScreenApi = path === "/api-meeting.php" || path === "/api-meeting";

      if (isDockApi && request.method === "POST") {
        return jsonResponse(await handleDockPost(request, env));
      }

      if (isDockApi && request.method === "GET") {
        return jsonResponse(await getDockState(env));
      }

      if (isMeetingScreenApi && request.method === "GET") {
        const agenda = await getAgenda(env);
        return jsonResponse(agenda.featured ? meetingApiPayload(agenda.featured) : {
          has_meeting: false,
          room_name: ROOM_NAME,
          status: "free",
        });
      }

      const sessionUser = await getSessionUser(request, env);
      if (!sessionUser) {
        if (path.startsWith("/api/")) {
          return jsonResponse({ ok: false, message: "Sesión caducada. Inicia sesión de nuevo." }, 401);
        }
        return redirectResponse(`${LOGIN_PATH}?next=${encodeURIComponent(path + url.search)}`);
      }

      if (!env.MEETINGS_KV) {
        return htmlResponse(renderSetupError(), 503);
      }

      if (path === "/api/meetings" && request.method === "GET") {
        return jsonResponse(await getAgenda(env));
      }

      if (path === "/api/users/password" && request.method === "POST") {
        return jsonResponse(await changeUserPassword(request, env, sessionUser));
      }

      if (path === "/api/meetings" && request.method === "POST") {
        return jsonResponse(await createMeeting(request, env));
      }

      const meetingUpdate = path.match(/^\/api\/meetings\/([^/]+)\/update$/);
      if (meetingUpdate && request.method === "POST") {
        return jsonResponse(await updateMeeting(request, env, meetingUpdate[1]));
      }

      const meetingAction = path.match(/^\/api\/meetings\/([^/]+)\/(finish|extend|delete)$/);
      if (meetingAction && request.method === "POST") {
        return jsonResponse(await updateMeetingAction(env, meetingAction[1], meetingAction[2]));
      }

      if (request.method === "GET") {
        const view = path.includes("add") ? "add" : path.includes("delete") || path.includes("manage") ? "manage" : "home";
        return htmlResponse(renderApp(view, sessionUser));
      }

      return jsonResponse({ ok: false, message: "Ruta no encontrada." }, 404);
    } catch (error) {
      return jsonResponse({ ok: false, message: error.message || "Error interno." }, 500);
    }
  }
};

async function handleLogin(request, env) {
  const form = await request.formData();
  const username = clean(form.get("username") || "");
  const password = String(form.get("password") || "");
  const next = sanitizeNextPath(String(form.get("next") || "/"));
  const user = await validateCredentials(username, password, env);

  if (!user) {
    return htmlResponse(renderLogin({
      error: "Usuario o contraseña incorrectos.",
      username,
      next,
    }), 401);
  }

  const sessionCookie = await createSessionCookie(user, env);
  return redirectResponse(next, { "set-cookie": sessionCookie });
}

async function handlePortalLogin(url, env) {
  if (!env.PORTAL_AUTH_DB || !env.AUTH_SECRET) {
    return htmlResponse(renderLogin({ error: "El acceso desde el portal todavía no está configurado." }), 503);
  }
  const code = String(url.searchParams.get("code") || "");
  if (!code) return htmlResponse(renderLogin({ error: "Código de acceso no válido." }), 400);

  const loginCode = await env.PORTAL_AUTH_DB.prepare(`
    DELETE FROM login_codes
    WHERE code_hash = ? AND application_code = ? AND expires_at > CURRENT_TIMESTAMP
    RETURNING user_id
  `).bind(await sha256Text(code), CURRENT_APP_CODE).first();
  if (!loginCode) return htmlResponse(renderLogin({ error: "El acceso ha caducado o ya fue utilizado." }), 403);

  const user = await env.PORTAL_AUTH_DB.prepare(`
    SELECT u.id, u.display_name, u.email, u.role, p.role AS application_role
    FROM users u
    LEFT JOIN user_application_permissions p
      ON p.user_id = u.id AND p.application_code = ?
    WHERE u.id = ? AND u.active = 1
      AND (u.role = 'admin' OR p.active = 1)
  `).bind(CURRENT_APP_CODE, loginCode.user_id).first();
  if (!user) return htmlResponse(renderLogin({ error: "No tienes permiso para acceder a Reuniones." }), 403);

  const sessionCookie = await createSessionCookie({
    username: user.display_name || user.email,
    role: user.role === "admin" || user.application_role === "admin" ? "admin" : "usuario",
    centralUserId: Number(user.id),
  }, env);
  return redirectResponse("/", { "set-cookie": sessionCookie, "referrer-policy": "no-referrer" });
}

function getAuthConfigError(env) {
  if (!env || !env.AUTH_SECRET || !env.AUTH_USERS) {
    return "Faltan AUTH_SECRET y AUTH_USERS en las variables del Worker.";
  }

  try {
    const users = JSON.parse(env.AUTH_USERS);
    if (!Array.isArray(users) || users.length === 0) {
      return "AUTH_USERS debe contener al menos un usuario.";
    }
  } catch {
    return "AUTH_USERS no tiene un JSON válido.";
  }

  return "";
}

async function validateCredentials(username, password, env) {
  const users = await loadAuthUsers(env);
  const user = users.find((item) => String(item.username || "").toLowerCase() === username.toLowerCase());
  if (!user || !user.passwordHash || !user.role) return null;

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return null;

  return {
    username: user.username,
    role: user.role === "admin" ? "admin" : "usuario",
  };
}

async function loadAuthUsers(env) {
  if (env.MEETINGS_KV) {
    const raw = await env.MEETINGS_KV.get(AUTH_USERS_KEY);
    if (raw) {
      try {
        const storedUsers = JSON.parse(raw);
        if (Array.isArray(storedUsers) && storedUsers.length > 0) return storedUsers;
      } catch {
        // Si el valor editable está corrupto, se usan los usuarios base del secreto.
      }
    }
  }

  const secretUsers = JSON.parse(env.AUTH_USERS);
  return Array.isArray(secretUsers) ? secretUsers : [];
}

async function saveAuthUsers(env, users) {
  if (!env.MEETINGS_KV) throw new Error("No está configurado el almacenamiento KV.");
  await env.MEETINGS_KV.put(AUTH_USERS_KEY, JSON.stringify(users, null, 2));
}

async function changeUserPassword(request, env, sessionUser) {
  if (sessionUser.role !== "admin") {
    return { ok: false, message: "Solo el administrador puede cambiar contraseñas." };
  }

  const data = await readRequestData(request);
  const username = clean(data.username || "usuario");
  const newPassword = String(data.new_password || "");

  if (newPassword.length < 8) {
    return { ok: false, message: "La nueva contraseña debe tener al menos 8 caracteres." };
  }

  const users = await loadAuthUsers(env);
  const user = users.find((item) => String(item.username || "").toLowerCase() === username.toLowerCase());
  if (!user) return { ok: false, message: "Usuario no encontrado." };

  user.passwordHash = await createPasswordHash(newPassword);
  await saveAuthUsers(env, users);
  return { ok: true, message: "Contraseña de usuario actualizada." };
}

async function getSessionUser(request, env) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const sessionUser = await verifySessionToken(token, env.AUTH_SECRET);
  if (!sessionUser?.centralUserId) return sessionUser;
  if (!env.PORTAL_AUTH_DB) return null;
  const authorization = await env.PORTAL_AUTH_DB.prepare(`
    SELECT u.display_name, u.email, u.role, p.role AS application_role
    FROM users u
    LEFT JOIN user_application_permissions p
      ON p.user_id = u.id AND p.application_code = ?
    WHERE u.id = ? AND u.active = 1
      AND (u.role = 'admin' OR p.active = 1)
  `).bind(CURRENT_APP_CODE, sessionUser.centralUserId).first();
  if (!authorization) return null;
  return {
    username: authorization.display_name || authorization.email,
    role: authorization.role === "admin" || authorization.application_role === "admin" ? "admin" : "usuario",
    centralUserId: sessionUser.centralUserId,
  };
}

async function createSessionCookie(user, env) {
  const payload = {
    username: user.username,
    role: user.role,
    centralUserId: user.centralUserId || null,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await signValue(encodedPayload, env.AUTH_SECRET);
  return `${SESSION_COOKIE}=${encodedPayload}.${signature}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

async function verifySessionToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [encodedPayload, signature] = parts;
  const expectedSignature = await signValue(encodedPayload, secret);
  if (!timingSafeEqual(signature, expectedSignature)) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.username || !payload.role) return null;
    return {
      username: String(payload.username),
      role: payload.role === "admin" ? "admin" : "usuario",
      centralUserId: payload.centralUserId ? Number(payload.centralUserId) : null,
    };
  } catch {
    return null;
  }
}

async function signValue(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

async function verifyPassword(password, passwordHash) {
  const parts = String(passwordHash).split("$");
  if (parts.length !== 3 || parts[0] !== "sha256") return false;

  const salt = base64UrlDecode(parts[1]);
  const expectedHash = base64UrlDecode(parts[2]);
  const actualHash = await sha256PasswordHash(password, salt);
  return timingSafeEqualBytes(actualHash, expectedHash);
}

async function sha256PasswordHash(password, salt) {
  const passwordBytes = new TextEncoder().encode(password);
  const payload = new Uint8Array(salt.length + passwordBytes.length);
  payload.set(salt, 0);
  payload.set(passwordBytes, salt.length);
  const hash = await crypto.subtle.digest("SHA-256", payload);
  return new Uint8Array(hash);
}

async function createPasswordHash(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await sha256PasswordHash(password, salt);
  return `sha256$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(";").forEach((part) => {
    const index = part.indexOf("=");
    if (index === -1) return;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = value;
  });
  return cookies;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a, b) {
  return timingSafeEqualBytes(new TextEncoder().encode(a), new TextEncoder().encode(b));
}

function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a[i] ^ b[i];
  return result === 0;
}

async function sha256Text(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(hash));
}

function sanitizeNextPath(value) {
  if (!value || !value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  return value;
}

function redirectResponse(location, extraHeaders = {}) {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

async function loadMeetings(env) {
  const raw = await env.MEETINGS_KV.get(MEETINGS_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveMeetings(env, meetings) {
  await env.MEETINGS_KV.put(MEETINGS_KEY, JSON.stringify(meetings, null, 2));
}

async function createMeeting(request, env) {
  const data = await readRequestData(request);
  const title = clean(data.title || "");
  const date = clean(data.date || "");
  const time = clean(data.time || "");
  const url = clean(data.url || "");
  const notes = clean(data.notes || "");
  const duration = clampNumber(Number(data.duration || DEFAULT_DURATION), 15, 480, DEFAULT_DURATION);

  if (!date || !time || !url) {
    return { ok: false, message: "Completa fecha, hora y enlace." };
  }

  if (!url.startsWith("https://")) {
    return { ok: false, message: "El enlace debe empezar por https://" };
  }

  const meetings = await loadMeetings(env);
  const newMeeting = { date, time, duration };
  const conflictingMeeting = findMeetingConflict(meetings, newMeeting);
  if (conflictingMeeting) {
    const conflict = enrichMeeting(conflictingMeeting);
    return {
      ok: false,
      message: `La sala ya está ocupada ese día y hora por "${conflict.title}" (${conflict.time_range}).`,
    };
  }

  meetings.push({
    id: crypto.randomUUID(),
    title: title || `Reunión de ${detectPlatform(url)}`,
    date,
    time,
    url,
    notes,
    duration,
    created_at: new Date().toISOString(),
  });

  await saveMeetings(env, meetings);
  return { ok: true, message: "Reunión añadida." };
}

async function updateMeeting(request, env, id) {
  const data = await readRequestData(request);
  const title = clean(data.title || "");
  const date = clean(data.date || "");
  const time = clean(data.time || "");
  const url = clean(data.url || "");
  const notes = clean(data.notes || "");
  const duration = clampNumber(Number(data.duration || DEFAULT_DURATION), 15, 480, DEFAULT_DURATION);

  if (!date || !time || !url) {
    return { ok: false, message: "Completa fecha, hora y enlace." };
  }

  if (!url.startsWith("https://")) {
    return { ok: false, message: "El enlace debe empezar por https://" };
  }

  const meetings = await loadMeetings(env);
  const meeting = meetings.find((item) => item.id === id);
  if (!meeting) return { ok: false, message: "Reunión no encontrada." };

  const candidate = { date, time, duration };
  const conflictingMeeting = findMeetingConflict(meetings, candidate, id);
  if (conflictingMeeting) {
    const conflict = enrichMeeting(conflictingMeeting);
    return {
      ok: false,
      message: `La sala ya está ocupada ese día y hora por "${conflict.title}" (${conflict.time_range}).`,
    };
  }

  meeting.title = title || `Reunión de ${detectPlatform(url)}`;
  meeting.date = date;
  meeting.time = time;
  meeting.url = url;
  meeting.notes = notes;
  meeting.duration = duration;
  meeting.updated_at = new Date().toISOString();
  delete meeting.ended_at;

  await saveMeetings(env, meetings);
  return { ok: true, message: "Reunión actualizada." };
}

async function updateMeetingAction(env, id, action) {
  if (action === "delete") return deleteMeeting(env, id);
  if (action === "finish") return finishMeeting(env, id);
  if (action === "extend") return extendMeeting(env, id, 15);
  return { ok: false, message: "Acción no válida." };
}

function findMeetingConflict(meetings, candidate, excludedId = "") {
  const candidateStart = meetingStart(candidate);
  const candidateEnd = meetingEnd(candidate);
  const now = new Date();

  return meetings.find((meeting) => {
    if ((meeting.id || "") === excludedId) return false;
    if (isFinished(meeting)) return false;

    const existingEnd = meetingEnd(meeting);
    if (existingEnd < now) return false;

    const existingStart = meetingStart(meeting);
    return candidateStart < existingEnd && candidateEnd > existingStart;
  }) || null;
}

async function finishMeeting(env, id) {
  const meetings = await loadMeetings(env);
  const meeting = meetings.find((item) => item.id === id);
  if (!meeting) return { ok: false, message: "Reunión no encontrada." };

  meeting.ended_at = new Date().toISOString();
  await saveMeetings(env, meetings);
  await env.MEETINGS_KV.delete(DOCK_KEY);
  return { ok: true, message: "Reunión finalizada." };
}

async function extendMeeting(env, id, minutes) {
  const meetings = await loadMeetings(env);
  const meeting = meetings.find((item) => item.id === id);
  if (!meeting) return { ok: false, message: "Reunión no encontrada." };

  meeting.duration = clampNumber(Number(meeting.duration || DEFAULT_DURATION) + minutes, 15, 480, DEFAULT_DURATION);
  await saveMeetings(env, meetings);
  return { ok: true, message: `Reunión extendida ${minutes} minutos.` };
}

async function deleteMeeting(env, id) {
  const meetings = await loadMeetings(env);
  const filtered = meetings.filter((item) => item.id !== id);
  if (filtered.length === meetings.length) return { ok: false, message: "Reunión no encontrada." };

  await saveMeetings(env, filtered);
  return { ok: true, message: "Reunión eliminada." };
}

async function handleDockPost(request, env) {
  const data = await readRequestData(request);
  const action = clean(data.action || "");
  const meetingId = clean(data.meeting_id || "");

  if (action === "activate" && meetingId) {
    await env.MEETINGS_KV.put(DOCK_KEY, JSON.stringify({
      active_meeting_id: meetingId,
      updated_at: new Date().toISOString(),
    }));
    return { ok: true };
  }

  if (action === "clear") {
    await env.MEETINGS_KV.delete(DOCK_KEY);
    return { ok: true };
  }

  if (action === "finish" && meetingId) return finishMeeting(env, meetingId);
  if (action === "extend" && meetingId) return extendMeeting(env, meetingId, 15);

  return { ok: false, message: "Acción no válida." };
}

async function getDockState(env) {
  const raw = await env.MEETINGS_KV.get(DOCK_KEY);
  const state = raw ? safeJson(raw, {}) : {};
  const meetingId = state.active_meeting_id || "";
  const meetings = await loadMeetings(env);
  const meeting = meetings.find((item) => item.id === meetingId);

  if (!meeting || isFinished(meeting) || meetingEnd(meeting) < new Date()) {
    const now = new Date();
    const liveMeeting = meetings.find((item) => !isFinished(item) && meetingStart(item) <= now && meetingEnd(item) >= now);

    if (liveMeeting) {
      return meetingApiPayload(enrichMeeting(liveMeeting));
    }

    return {
      has_meeting: false,
      room_name: ROOM_NAME,
      status: "idle",
    };
  }

  return meetingApiPayload(enrichMeeting(meeting));
}

async function getAgenda(env) {
  const now = new Date();
  const meetings = (await loadMeetings(env))
    .filter((meeting) => !isFinished(meeting) && meetingEnd(meeting) >= now)
    .map(enrichMeeting)
    .sort((a, b) => a.start_ts - b.start_ts);

  const ongoing = meetings.find((meeting) => meeting.start_ts <= now.getTime() && meeting.end_ts >= now.getTime()) || null;
  const next = meetings.find((meeting) => meeting.start_ts > now.getTime()) || null;
  const featured = ongoing || next || null;
  const todayKey = formatParts(now).dateKey;
  const todayCount = meetings.filter((meeting) => meeting.date === todayKey).length;

  return {
    ok: true,
    room_name: ROOM_NAME,
    now: formatClock(now),
    room_busy: Boolean(ongoing),
    today_count: todayCount,
    visible_count: meetings.length,
    featured,
    meetings,
  };
}

function enrichMeeting(meeting) {
  const start = meetingStart(meeting);
  const end = meetingEnd(meeting);
  const status = meetingStatus(meeting);

  return {
    ...meeting,
    platform: detectPlatform(meeting.url || ""),
    status: status.label,
    status_class: status.class,
    date_label: formatMeetingDate(start),
    time_range: `${formatClock(start)} - ${formatClock(end)}`,
    duration: meetingDuration(meeting),
    start_ts: start.getTime(),
    end_ts: end.getTime(),
  };
}

function meetingApiPayload(meeting) {
  return {
    has_meeting: true,
    room_name: ROOM_NAME,
    id: meeting.id || "",
    title: meeting.title || "Reunión sin título",
    platform: meeting.platform || detectPlatform(meeting.url || ""),
    status: meeting.status || meetingStatus(meeting).label,
    status_class: meeting.status_class || meetingStatus(meeting).class,
    date: meeting.date_label || formatMeetingDate(meetingStart(meeting)),
    time_range: meeting.time_range || `${formatClock(meetingStart(meeting))} - ${formatClock(meetingEnd(meeting))}`,
    duration: meetingDuration(meeting),
  };
}

function meetingStatus(meeting) {
  const now = new Date();
  const start = meetingStart(meeting);
  const end = meetingEnd(meeting);
  const diffMinutes = Math.ceil((start.getTime() - now.getTime()) / 60000);

  if (start <= now && end >= now) return { class: "live", label: "En curso" };
  if (diffMinutes >= 0 && diffMinutes <= 15) return { class: "soon", label: `Empieza en ${diffMinutes} min` };
  return { class: "scheduled", label: "Programada" };
}

function meetingStart(meeting) {
  return zonedTimeToUtc(meeting.date, meeting.time);
}

function meetingEnd(meeting) {
  return new Date(meetingStart(meeting).getTime() + meetingDuration(meeting) * 60000);
}

function meetingDuration(meeting) {
  return clampNumber(Number(meeting.duration || DEFAULT_DURATION), 15, 480, DEFAULT_DURATION);
}

function isFinished(meeting) {
  return Boolean(meeting.ended_at);
}

function detectPlatform(url) {
  const lower = String(url).toLowerCase();
  if (lower.includes("teams.microsoft.com")) return "Teams";
  if (lower.includes("zoom.us")) return "Zoom";
  if (lower.includes("meet.google.com")) return "Google Meet";
  if (lower.includes("webex.com")) return "Webex";
  return "Otro";
}

function platformIcon(platform) {
  if (platform === "Teams") return "▣";
  if (platform === "Zoom") return "◎";
  if (platform === "Google Meet") return "◈";
  if (platform === "Webex") return "◇";
  return "●";
}

async function readRequestData(request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return await request.json();

  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

function clean(value) {
  return String(value || "").trim();
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function safeJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function formatParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parts.hour,
    minute: parts.minute,
  };
}

function formatClock(date) {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatMeetingDate(date) {
  const value = new Intl.DateTimeFormat("es-ES", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function zonedTimeToUtc(dateString, timeString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const [hour, minute] = timeString.split(":").map(Number);
  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  let offset = getTimeZoneOffset(TZ, utc);
  utc = new Date(utc.getTime() - offset);
  offset = getTimeZoneOffset(TZ, utc);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - offset);
}

function getTimeZoneOffset(timeZone, date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = Number(part.value);
    return acc;
  }, {});

  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderSetupError() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Configurar KV</title><style>body{font-family:Inter,Arial,sans-serif;background:#f5f2ed;color:#111827;padding:40px}.card{max-width:760px;background:white;border:1px solid #ddd;border-radius:18px;padding:28px;box-shadow:0 18px 50px #0001}code{background:#f6f6f6;padding:2px 6px;border-radius:6px}</style></head><body><main class="card"><h1>Falta configurar Cloudflare KV</h1><p>Este portal ya no usa PHP. Necesita un KV Namespace vinculado al Worker con el nombre <code>MEETINGS_KV</code>.</p><p>Crea el KV en Cloudflare y añade el binding al Worker.</p></main></body></html>`;
}

function renderLoginSetupError(message) {
  return renderLoginShell(`
    <section class="login-card">
      <div class="mark">C</div>
      <p class="eyebrow">Portal de reuniones</p>
      <h1>Falta activar el login</h1>
      <p class="copy">${escapeHtml(message)}</p>
    </section>
  `, "Configurar login");
}

function renderLogin({ error = "", username = "", next = "/" } = {}) {
  return renderLoginShell(`
    <form class="login-card" method="post" action="${LOGIN_PATH}" autocomplete="on">
      <div class="mark">C</div>
      <p class="eyebrow">Cámara de Ceuta</p>
      <h1>Acceso a reuniones</h1>
      <p class="copy">Inicia sesión para ver, añadir y gestionar reservas de la sala.</p>
      ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
      <input type="hidden" name="next" value="${escapeHtml(sanitizeNextPath(next))}">
      <label>
        <span>Usuario</span>
        <input name="username" type="text" value="${escapeHtml(username)}" autocomplete="username" required autofocus>
      </label>
      <label>
        <span>Contraseña</span>
        <input name="password" type="password" autocomplete="current-password" required>
      </label>
      <button type="submit">Entrar</button>
    </form>
  `, "Acceso");
}

function renderLoginShell(content, title) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Portal de reuniones</title>
<style>
:root{--red:#e11d2f;--navy:#0b2d4d;--gold:#d6b20e;--line:#d8e0ea;--ink:#111827;--muted:#667085;--bg:#f4f1ec}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top left,rgba(225,29,47,.14),transparent 32%),radial-gradient(circle at top right,rgba(214,178,14,.18),transparent 34%),var(--bg);color:var(--ink);font-family:Inter,Segoe UI,Arial,sans-serif}.login-card{width:min(440px,100%);padding:34px;border:1px solid var(--line);border-top:7px solid var(--red);border-radius:24px;background:rgba(255,255,255,.94);box-shadow:0 28px 80px rgba(11,45,77,.16)}.mark{width:62px;height:62px;border-radius:18px;display:grid;place-items:center;margin-bottom:22px;color:#fff;background:linear-gradient(135deg,var(--navy),var(--red));font-size:1.45rem;font-weight:950}.eyebrow{margin:0 0 8px;color:var(--red);font-size:.78rem;font-weight:950;letter-spacing:.16em;text-transform:uppercase}h1{margin:0 0 10px;color:var(--navy);font-size:2.15rem;line-height:1.05}.copy{margin:0 0 22px;color:var(--muted);font-weight:700;line-height:1.55}.error{margin:0 0 18px;padding:12px 14px;border:1px solid rgba(225,29,47,.25);border-radius:14px;background:#fff1f3;color:#a50f1e;font-weight:900}label{display:grid;gap:7px;margin-bottom:16px;color:var(--navy);font-weight:900}input{width:100%;min-height:50px;border:1px solid var(--line);border-radius:14px;padding:12px 14px;font:inherit}input:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 4px rgba(225,29,47,.12)}button{width:100%;min-height:52px;border:0;border-radius:999px;background:linear-gradient(135deg,var(--red),#f43f5e);color:#fff;font-weight:950;font-size:1rem;cursor:pointer;box-shadow:0 18px 34px rgba(225,29,47,.24)}
</style>
</head>
<body>${content}</body>
</html>`;
}

function renderApp(initialView, sessionUser) {
  const sessionLabel = escapeHtml(sessionUser?.username || "Usuario");
  const isAdmin = sessionUser?.role === "admin";
  const roleBadge = isAdmin ? "<strong>Admin</strong>" : "";
  const adminPasswordPanel = isAdmin ? `
      <div class="admin-password-card">
        <div>
          <p class="eyebrow">Administración</p>
          <h3>Cambiar contraseña de usuario</h3>
          <p class="muted">Actualiza la contraseña del acceso normal sin tocar el despliegue.</p>
        </div>
        <form id="passwordForm" class="password-form">
          <input type="hidden" name="username" value="usuario">
          <label>
            <span>Nueva contraseña</span>
            <input name="new_password" type="password" minlength="8" autocomplete="new-password" placeholder="Mínimo 8 caracteres" required>
          </label>
          <button class="btn btn-filled" type="submit">Actualizar contraseña</button>
        </form>
      </div>` : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ROOM_NAME} | Portal de reuniones</title>
<style>
:root{--red:#e11d2f;--red-dark:#a50f1e;--navy:#0b2d4d;--blue:#123c68;--gold:#d6b20e;--bg:#f4f1ec;--surface:#fff;--soft:#f7f9fc;--line:#d8e0ea;--ink:#111827;--muted:#667085;--green:#067647;--green-soft:#dcfae6;--yellow-soft:#fff3bd;--shadow:0 18px 54px rgba(11,45,77,.12);--radius:18px}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,rgba(225,29,47,.10),transparent 32%),radial-gradient(circle at top right,rgba(214,178,14,.16),transparent 34%),var(--bg);color:var(--ink);font-family:Inter,Segoe UI,Arial,sans-serif}.topbar,.shell{width:min(1500px,calc(100% - 32px));margin:0 auto}.topbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-top:14px;padding:26px 28px;background:#fff;border:1px solid var(--line);border-top:7px solid var(--red);border-radius:10px;box-shadow:var(--shadow)}.brand{display:flex;align-items:center;gap:24px}.brand-logo{display:flex;align-items:center;justify-content:center;min-width:280px;width:280px}.brand-logo img{display:block;width:100%;height:auto;object-fit:contain}.eyebrow{margin:0 0 6px;color:var(--red);font-weight:900;font-size:.78rem;letter-spacing:.16em;text-transform:uppercase}.topbar h1{margin:0;font-size:clamp(2.4rem,5vw,4.8rem);line-height:.95}.room-state{min-width:210px;padding:18px 22px;border-radius:12px;text-align:right;background:var(--green-soft);color:var(--green)}.room-state.busy{background:var(--yellow-soft);color:var(--red-dark)}.room-state strong{font-size:2.45rem;font-variant-numeric:tabular-nums}.shell{padding:24px 0 54px}.overview-grid{display:grid;grid-template-columns:1.15fr .85fr .85fr;gap:16px;margin-bottom:14px}.metric-card{min-height:104px;padding:18px 20px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);box-shadow:0 12px 30px rgba(11,45,77,.06)}.metric-card.primary{background:linear-gradient(135deg,var(--navy),var(--blue));color:#fff}.metric-card span{display:block;font-size:.78rem;text-transform:uppercase;letter-spacing:.16em;font-weight:900;color:inherit;opacity:.76}.metric-card strong{display:block;margin-top:8px;font-size:2.45rem;line-height:1}.metric-card small{display:block;margin-top:8px;font-weight:800;color:inherit;opacity:.72}.hero-panel{display:grid;grid-template-columns:minmax(0,1fr) 210px;overflow:hidden;border:1px solid var(--line);border-left:1px solid var(--gold);border-radius:10px;background:#fff;box-shadow:var(--shadow);margin-bottom:18px}.hero-panel.empty{display:flex;align-items:center;justify-content:space-between;padding:30px}.hero-copy{padding:28px}.hero-labels,.meeting-badges{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.status-chip,.platform-chip{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:8px 11px;font-size:.72rem;text-transform:uppercase;font-weight:900;letter-spacing:.04em}.status-chip.live{background:var(--red);color:#fff}.status-chip.soon{background:var(--yellow-soft);color:#9a6700}.status-chip.scheduled{background:var(--soft);color:var(--muted)}.platform-chip{background:#eef4ff;color:#073b72}.hero-panel h2{margin:12px 0 10px;font-size:clamp(2rem,4.2vw,3.9rem);line-height:1.02}.hero-meta{display:flex;gap:10px;flex-wrap:wrap}.hero-meta span{border-radius:999px;background:var(--soft);padding:10px 12px;color:#536179;font-weight:900}.hero-notes,.meeting-notes{color:var(--muted);font-weight:650}.join-button{display:inline-flex;align-items:center;justify-content:center;gap:12px;border:0;border-radius:8px;background:var(--red);color:#fff;text-decoration:none;font-weight:900;box-shadow:0 18px 34px rgba(225,29,47,.24);cursor:pointer}.join-button.featured{border-radius:0;font-size:1.65rem}.agenda-panel,.form-panel{background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);padding:28px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:20px}.section-heading h2{margin:0;font-size:2rem}.header-actions,.form-actions{display:flex;gap:10px;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 20px;border-radius:999px;border:1px solid var(--line);background:#fff;color:var(--navy);font-weight:900;text-decoration:none;cursor:pointer}.btn-filled,.primary-button{background:var(--red);border-color:var(--red);color:#fff}.btn-danger{background:#fff1f3;color:var(--red);border-color:#ffcbd1}.meeting-list{display:grid;gap:10px}.meeting-card{display:grid;grid-template-columns:190px minmax(0,1fr) 172px;gap:18px;align-items:center;padding:14px 16px;border:1px solid var(--line);border-left:7px solid var(--gold);border-radius:8px;background:linear-gradient(90deg,#fff9df,#fff 22%)}.meeting-card.live{border-left-color:var(--red)}.meeting-time-block strong{display:block;color:var(--navy);font-size:1.2rem}.meeting-time-block span{display:block;margin-top:8px;color:#536179;font-weight:800}.meeting-main h3{margin:10px 0 0;font-size:1.45rem}.empty-state{padding:28px;border-radius:12px;background:var(--soft);text-align:center;color:var(--muted)}.notice{position:fixed;right:22px;bottom:22px;z-index:5;background:var(--navy);color:#fff;padding:14px 18px;border-radius:12px;box-shadow:var(--shadow);font-weight:800}.views{display:none}.views.active{display:block}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.field{display:grid;gap:7px}.field.full{grid-column:1/-1}.field label{font-weight:900;color:var(--navy)}.field-help{display:block;color:var(--muted);font-size:.9rem;font-weight:650}input,textarea,select{width:100%;min-height:48px;border:1px solid var(--line);border-radius:12px;padding:12px 14px;font:inherit}textarea{min-height:110px;resize:vertical}.manage-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:14px 0;border-bottom:1px solid var(--line)}.manage-row:last-child{border-bottom:0}.muted{color:var(--muted)}@media(max-width:900px){.topbar,.brand{align-items:flex-start}.topbar,.brand,.section-heading{flex-direction:column}.overview-grid,.hero-panel,.meeting-card,.form-grid{grid-template-columns:1fr}.join-button.featured{min-height:88px}.brand-logo{min-width:220px;width:220px}.room-state{width:100%;text-align:left}.meeting-card .join-button,.btn{width:100%}}
.hero-actions{display:grid;grid-template-rows:1fr auto;background:linear-gradient(135deg,var(--red),#f43f5e)}.meeting-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}.join-button{position:relative;min-height:58px;padding:0 24px;border-radius:14px;background:linear-gradient(135deg,#e11d2f,#f43f5e);font-weight:950;letter-spacing:.01em;box-shadow:0 18px 34px rgba(225,29,47,.28);transition:transform .16s ease,box-shadow .16s ease,filter .16s ease}.join-button:hover{transform:translateY(-2px);box-shadow:0 22px 42px rgba(225,29,47,.36);filter:saturate(1.08)}.join-button.featured{border-radius:0;min-height:100%;font-size:1.75rem;box-shadow:none}.edit-button{display:inline-flex;align-items:center;justify-content:center;min-height:50px;padding:0 18px;border-radius:14px;border:1px solid var(--line);background:#fff;color:var(--navy);font:inherit;font-weight:950;text-decoration:none;cursor:pointer}.edit-button:hover{border-color:#b8c4d2;box-shadow:0 12px 24px rgba(11,45,77,.10)}.hero-actions .edit-button{min-height:58px;border:0;border-top:1px solid rgba(255,255,255,.45);border-radius:0;background:rgba(255,255,255,.96);color:var(--navy)}@media(max-width:900px){.meeting-actions{width:100%}.meeting-card .edit-button{width:100%}}
.header-actions .btn:not(.btn-filled),.edit-button{position:relative;overflow:hidden;border:1.5px solid #123c68!important;background:linear-gradient(180deg,#ffffff,#f9fbfe)!important;color:var(--navy)!important;box-shadow:0 8px 18px rgba(11,45,77,.08)!important}.header-actions .btn:not(.btn-filled)::before,.edit-button::before{content:"";position:absolute;left:18px;right:18px;top:0;height:3px;background:linear-gradient(90deg,var(--gold),#f3d34a);border-radius:0 0 999px 999px}.header-actions .btn:not(.btn-filled):hover,.edit-button:hover{transform:translateY(-1px);border-color:var(--navy)!important;background:#fff!important;box-shadow:0 12px 26px rgba(11,45,77,.13)!important}.hero-actions .edit-button{min-height:58px;border:0!important;border-top:1px solid rgba(11,45,77,.16)!important;border-radius:0!important;background:linear-gradient(180deg,#ffffff,#f9fbfe)!important;box-shadow:none!important}.hero-actions .edit-button::before{left:32%;right:32%;top:0;height:3px;border-radius:0 0 999px 999px}
.hero-panel .hero-actions{display:flex!important;flex-direction:column;align-items:stretch;justify-content:center;gap:14px;padding:18px;background:linear-gradient(180deg,#fff7f8,#ffffff)!important}.hero-panel .join-button.featured{min-height:86px;border-radius:16px!important;font-size:1.55rem;box-shadow:0 22px 42px rgba(225,29,47,.28)!important}.hero-panel .edit-button{min-height:54px;border:1.5px solid #123c68!important;border-radius:16px!important;background:#fff!important;box-shadow:0 10px 22px rgba(11,45,77,.08)!important}.hero-panel .edit-button::before{left:34%;right:34%;top:0;height:3px;border-radius:0 0 999px 999px}
.agenda-toolbar{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:4px 0 18px;padding:16px 18px;border:1px solid var(--line);border-radius:16px;background:linear-gradient(135deg,#ffffff,#f8fbff);box-shadow:0 10px 26px rgba(11,45,77,.07)}.agenda-toolbar-text{display:grid;gap:3px}.agenda-toolbar-text strong{color:var(--navy);font-size:1rem}.agenda-toolbar-text span{color:var(--muted);font-size:.9rem;font-weight:700}.agenda-toolbar-actions{display:flex;justify-content:flex-end;gap:12px;flex-wrap:wrap}.agenda-toolbar .btn{min-width:150px}.agenda-toolbar .btn-filled{box-shadow:0 14px 28px rgba(225,29,47,.20)}.hero-panel .hero-actions.single-action{padding:0;background:linear-gradient(135deg,var(--red),#f43f5e)!important}.hero-panel .hero-actions.single-action .join-button.featured{height:100%;min-height:100%;border-radius:0!important;box-shadow:none!important}.room-state{display:flex;align-items:center;justify-content:center;gap:14px;text-align:left}.clock-label{color:var(--green);font-size:.78rem;font-weight:950;letter-spacing:.16em;text-transform:uppercase}.room-state.busy .clock-label{color:var(--red-dark)}@media(max-width:900px){.agenda-toolbar{align-items:stretch;flex-direction:column}.agenda-toolbar-actions{flex-direction:column}.agenda-toolbar .btn{width:100%}}
.agenda-toolbar .btn:not(.btn-filled){position:relative;overflow:hidden;border:1.5px solid #123c68!important;background:linear-gradient(180deg,#ffffff,#f9fbfe)!important;color:var(--navy)!important;box-shadow:0 8px 18px rgba(11,45,77,.08)!important}.agenda-toolbar .btn:not(.btn-filled)::before{content:"";position:absolute;left:22px;right:22px;top:0;height:3px;background:linear-gradient(90deg,var(--gold),#f3d34a);border-radius:0 0 999px 999px}.agenda-toolbar .btn:not(.btn-filled):hover{transform:translateY(-1px);border-color:var(--navy)!important;background:#fff!important;box-shadow:0 12px 26px rgba(11,45,77,.13)!important}
.hero-panel .hero-actions.single-action{padding:24px!important;background:transparent!important;align-items:center!important;justify-content:center!important}.hero-panel .hero-actions.single-action .join-button.featured{width:auto!important;height:auto!important;min-height:66px!important;border-radius:18px!important;padding:0 38px!important;font-size:1.35rem!important;box-shadow:0 22px 42px rgba(225,29,47,.30)!important}.hero-panel .hero-actions.single-action .join-button.featured:hover{transform:translateY(-2px) scale(1.01)}
.agenda-toolbar{border:1.8px solid rgba(18,60,104,.28)!important;border-left:5px solid var(--gold)!important;box-shadow:0 12px 30px rgba(11,45,77,.10)!important}.meeting-card{border:1.8px solid rgba(18,60,104,.22)!important;border-left:7px solid var(--gold)!important;box-shadow:0 8px 20px rgba(11,45,77,.055)!important}.meeting-card.live{border-left-color:var(--red)!important}.meeting-card:hover{border-color:rgba(18,60,104,.38)!important;box-shadow:0 12px 28px rgba(11,45,77,.09)!important}
.join-button{white-space:nowrap;line-height:1!important;flex-direction:row!important}.hero-panel .hero-actions.single-action .join-button.featured{display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:10px!important;min-width:150px!important;padding:0 32px!important}.meeting-card .join-button{white-space:nowrap;min-width:118px}
.hero-panel h2{max-width:980px!important;font-size:clamp(2rem,3.05vw,3.05rem)!important;line-height:1.08!important;letter-spacing:-.035em!important}.hero-copy{padding:26px 30px!important}.hero-meta{margin-top:12px!important}
.admin-password-card{display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,.72fr);gap:22px;align-items:end;margin-bottom:18px;padding:20px;border:1.5px solid rgba(18,60,104,.28);border-left:7px solid var(--gold);border-radius:16px;background:linear-gradient(135deg,#ffffff,#f8fbff);box-shadow:0 12px 28px rgba(11,45,77,.08)}.admin-password-card h3{margin:0 0 8px;color:var(--navy);font-size:1.35rem}.password-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:end}.password-form label{display:grid;gap:7px;color:var(--navy);font-weight:900}.password-form span{font-size:.9rem}.password-form .btn{min-height:48px;white-space:nowrap}@media(max-width:900px){.admin-password-card,.password-form{grid-template-columns:1fr}}
.top-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end}.session-card{display:inline-flex;align-items:center;gap:10px;min-height:46px;padding:0 14px;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--navy);font-weight:950;box-shadow:0 10px 24px rgba(11,45,77,.08)}.session-card strong{color:var(--red);font-size:.72rem;letter-spacing:.12em;text-transform:uppercase}.session-card a{color:var(--muted);text-decoration:none;font-size:.88rem}.session-card a:hover{color:var(--red)}@media(max-width:900px){.top-actions{width:100%;justify-content:space-between}.session-card{width:100%;justify-content:center}}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <div class="brand-logo" aria-label="C?mara de Comercio de Ceuta"><img src="data:image/png;base64,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" alt="C?mara de Comercio de Ceuta"></div>
    <div><p class="eyebrow">Panel interno de sala</p><h1>${escapeHtml(ROOM_NAME)}</h1></div>
  </div>
  <div class="top-actions">
    <div class="session-card" aria-label="Sesión iniciada"><span>${sessionLabel}</span>${roleBadge}<a href="${LOGOUT_PATH}">Salir</a></div>
    <div class="room-state" id="roomState"><span class="clock-label">Hora</span><strong id="liveClock">--:--</strong></div>
  </div>
</header>

<main class="shell">
  <section class="views active" id="homeView">
    <section class="overview-grid" aria-label="Resumen de la sala">
      <article class="metric-card primary"><span>Estado actual</span><strong id="stateText">Libre</strong><small id="stateSmall">Disponible para la próxima reunión</small></article>
      <article class="metric-card"><span>Reuniones hoy</span><strong id="todayCount">0</strong><small>Programadas desde ahora</small></article>
      <article class="metric-card"><span>Agenda visible</span><strong id="visibleCount">0</strong><small>Reuniones activas o futuras</small></article>
    </section>
    <section id="featuredContainer"></section>
    <section class="agenda-panel">
      <div class="section-heading"><div><p class="eyebrow">Agenda de la sala</p><h2>Reuniones activas y próximas</h2></div></div>
      <div class="agenda-toolbar"><div class="agenda-toolbar-text"><strong>Acciones de agenda</strong><span>Gestiona o añade una reserva antes del listado.</span></div><div class="agenda-toolbar-actions"><button class="btn" data-view="manage">Gestionar agenda</button><button class="btn btn-filled" data-view="add">Añadir reunión</button></div></div>
      <div id="meetingList"></div>
    </section>
  </section>

  <section class="views" id="addView">
    <section class="form-panel"><div class="section-heading"><div><p class="eyebrow" id="formModeEyebrow">Nueva reserva</p><h2 id="formModeTitle">Añadir reunión</h2></div><button class="btn" data-view="home">Volver</button></div>
      <form id="addForm" class="form-grid">
        <div class="field full"><label>Pegar invitación o enlace</label><textarea class="quick-paste" name="invite_text" placeholder="Pega aquí una invitación completa de Teams, Zoom, Google Meet, Webex o solo el enlace."></textarea><span class="field-help">Opcional. El portal intentará rellenar título y enlace automáticamente.</span></div>
        <div class="field"><label>Título</label><input name="title" maxlength="120" placeholder="Se puede autocompletar"></div>
        <div class="field"><label>Enlace</label><input name="url" required placeholder="https://..."></div>
        <div class="field"><label>Fecha</label><input name="date" type="date" required></div>
        <div class="field"><label>Hora</label><input name="time" type="time" required></div>
        <div class="field"><label>Duración</label><select name="duration"><option value="30">30 min</option><option value="60" selected>60 min</option><option value="90">90 min</option><option value="120">120 min</option></select></div>
        <div class="field full"><label>Observaciones</label><textarea name="notes" placeholder="Notas opcionales"></textarea></div>
        <div class="form-actions field full"><button class="btn btn-filled" id="saveMeetingButton" type="submit">Guardar reunión</button></div>
      </form>
    </section>
  </section>

  <section class="views" id="manageView">
    <section class="form-panel"><div class="section-heading"><div><p class="eyebrow">Gestión</p><h2>Borrar reuniones</h2></div><button class="btn" data-view="home">Volver</button></div>${adminPasswordPanel}<div id="manageList"></div></section>
  </section>
</main>

<script>window.APP_INITIAL_VIEW=${JSON.stringify(initialView)};window.IS_ADMIN=${JSON.stringify(isAdmin)};</script>
<script>
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
let agenda = null;
let editingMeetingId = null;

function showNotice(message) {
  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.textContent = message;
  document.body.appendChild(notice);
  setTimeout(() => notice.remove(), 3800);
}

function setView(view, options = {}) {
  $$('.views').forEach((item) => item.classList.remove('active'));
  $('#' + view + 'View').classList.add('active');
  history.replaceState(null, '', view === 'home' ? '/' : view === 'add' ? '/add.php' : '/delete.php');
  if (view === 'add' && !options.keepForm) resetAddForm();
  if (view === 'manage') renderManage();
}

function tick() {
  const now = new Date();
  $('#liveClock').textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  if (response.status === 401) {
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
    throw new Error('Sesión caducada');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Error de servidor');
  return data;
}

async function loadAgenda() {
  agenda = await api('/api/meetings');
  renderHome();
  if ($('#manageView').classList.contains('active')) renderManage();
}

function renderHome() {
  $('#roomState').classList.toggle('busy', agenda.room_busy);
  $('#stateText').textContent = agenda.room_busy ? 'En reunión' : 'Libre';
  $('#stateSmall').textContent = agenda.room_busy ? 'Hay una reunión en curso' : 'Disponible para la próxima reunión';
  $('#todayCount').textContent = agenda.today_count;
  $('#visibleCount').textContent = agenda.visible_count;
  renderFeatured();
  renderList();
}

function chipStatus(meeting) { return '<span class="status-chip ' + meeting.status_class + '">' + escapeHtml(meeting.status) + '</span>'; }
function chipPlatform(meeting) { return '<span class="platform-chip">' + platformIcon(meeting.platform) + ' ' + escapeHtml(meeting.platform) + '</span>'; }
function platformIcon(platform) { return platform === 'Teams' ? '▣' : platform === 'Zoom' ? '◎' : platform === 'Google Meet' ? '◈' : platform === 'Webex' ? '◇' : '●'; }

function renderFeatured() {
  const box = $('#featuredContainer');
  const meeting = agenda.featured;
  if (!meeting) {
    box.innerHTML = '<section class="hero-panel empty"><div><p class="eyebrow">Sin próximas reuniones</p><h2>La sala está disponible</h2><p class="muted">No hay reuniones pendientes. Cuando alguien añada una reserva, aparecerá automáticamente aquí.</p></div></section>';
    return;
  }

  box.innerHTML = '<section class="hero-panel ' + meeting.status_class + '"><div class="hero-copy"><div class="hero-labels">' + chipStatus(meeting) + chipPlatform(meeting) + '</div><p class="eyebrow">' + (meeting.status_class === 'live' ? 'Reunión en curso' : 'Próxima reunión') + '</p><h2>' + escapeHtml(meeting.title) + '</h2><div class="hero-meta"><span>' + escapeHtml(meeting.date_label) + '</span><span>' + escapeHtml(meeting.time_range) + '</span><span>' + meeting.duration + ' min</span></div>' + (meeting.notes ? '<p class="hero-notes">' + escapeHtml(meeting.notes) + '</p>' : '') + '</div><div class="hero-actions single-action"><a class="join-button featured" href="' + escapeHtml(meeting.url) + '" target="_blank" rel="noopener noreferrer" data-meeting-id="' + meeting.id + '">Unirse →</a></div></section>';
  bindJoinButtons();
}

function renderList() {
  const list = $('#meetingList');
  if (!agenda.meetings.length) {
    list.innerHTML = '<div class="empty-state"><h3>No hay reuniones pendientes</h3><p>La agenda se actualiza sola cada 30 segundos.</p></div>';
    return;
  }

  list.innerHTML = '<div class="meeting-list">' + agenda.meetings.map((meeting) => '<article class="meeting-card ' + meeting.status_class + '"><div class="meeting-time-block"><strong>' + escapeHtml(meeting.time_range) + '</strong><span>' + escapeHtml(meeting.date_label) + '</span></div><div class="meeting-main"><div class="meeting-badges">' + chipStatus(meeting) + chipPlatform(meeting) + '</div><h3>' + escapeHtml(meeting.title) + '</h3>' + (meeting.notes ? '<p class="meeting-notes">' + escapeHtml(meeting.notes) + '</p>' : '') + '</div><div class="meeting-actions"><a class="join-button" href="' + escapeHtml(meeting.url) + '" target="_blank" rel="noopener noreferrer" data-meeting-id="' + meeting.id + '">Unirse →</a><button class="edit-button" type="button" data-edit-id="' + meeting.id + '">Editar</button></div></article>').join('') + '</div>';
  bindJoinButtons();
  bindEditButtons();
}

function renderManage() {
  const list = $('#manageList');
  if (!agenda || !agenda.meetings.length) {
    list.innerHTML = '<div class="empty-state"><h3>No hay reuniones para gestionar</h3></div>';
    return;
  }

  list.innerHTML = agenda.meetings.map((meeting) => '<div class="manage-row"><div><strong>' + escapeHtml(meeting.title) + '</strong><p class="muted">' + escapeHtml(meeting.date_label) + ' · ' + escapeHtml(meeting.time_range) + ' · ' + escapeHtml(meeting.platform) + '</p></div><button class="btn btn-danger" data-delete="' + meeting.id + '">Borrar</button></div>').join('');
  $$('[data-delete]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('¿Borrar esta reunión?')) return;
    const result = await api('/api/meetings/' + button.dataset.delete + '/delete', { method: 'POST' });
    showNotice(result.message);
    await loadAgenda();
  }));
}

function bindJoinButtons() {
  $$('[data-meeting-id]').forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const body = new URLSearchParams();
      body.set('action', 'activate');
      body.set('meeting_id', button.dataset.meetingId);
      fetch('/api-dock.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, keepalive: true }).catch(() => {});
      window.open(button.href, '_blank', 'noopener,noreferrer');
    });
  });
}

function bindEditButtons() {
  $$('[data-edit-id]').forEach((button) => {
    if (button.dataset.editBound) return;
    button.dataset.editBound = 'true';
    button.addEventListener('click', () => editMeeting(button.dataset.editId));
  });
}

function resetAddForm() {
  const form = $('#addForm');
  if (!form) return;
  form.reset();
  editingMeetingId = null;
  $('#formModeEyebrow').textContent = 'Nueva reserva';
  $('#formModeTitle').textContent = 'Añadir reunión';
  $('#saveMeetingButton').textContent = 'Guardar reunión';
}

function editMeeting(id) {
  const meeting = (agenda && agenda.meetings ? agenda.meetings : []).find((item) => item.id === id);
  if (!meeting) {
    showNotice('No se ha encontrado la reunión.');
    return;
  }

  const form = $('#addForm');
  editingMeetingId = id;
  form.elements.invite_text.value = '';
  form.elements.title.value = meeting.title || '';
  form.elements.url.value = meeting.url || '';
  form.elements.date.value = meeting.date || '';
  form.elements.time.value = meeting.time || '';
  form.elements.duration.value = String(meeting.duration || 60);
  form.elements.notes.value = meeting.notes || '';
  $('#formModeEyebrow').textContent = 'Editar reserva';
  $('#formModeTitle').textContent = 'Editar reunión';
  $('#saveMeetingButton').textContent = 'Guardar cambios';
  setView('add', { keepForm: true });
}

function escapeHtml(value) {
  return String(value || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}

function platformFromUrl(url) {
  const lowerUrl = String(url || '').toLowerCase();

  if (lowerUrl.includes('teams.microsoft.com')) return 'Teams';
  if (lowerUrl.includes('zoom.us')) return 'Zoom';
  if (lowerUrl.includes('meet.google.com')) return 'Google Meet';
  if (lowerUrl.includes('webex.com')) return 'Webex';

  return 'Otro';
}

function cleanTitle(text) {
  return String(text || '')
    .replace(/^asunto\\s*:/i, '')
    .replace(/^subject\\s*:/i, '')
    .replace(/^título\\s*:/i, '')
    .replace(/^titulo\\s*:/i, '')
    .trim()
    .slice(0, 120);
}

function looksLikeTitle(line) {
  const value = String(line || '').trim();
  const lowerValue = value.toLowerCase();

  if (value.length < 4 || value.startsWith('http')) return false;

  return ![
    'microsoft teams', 'unirse a la reunión', 'unirse a la reunion',
    'join the meeting', 'meeting id', 'id. de reunión', 'id. de reunion',
    'código de acceso', 'codigo de acceso', 'passcode', 'contraseña',
    'google meet', 'zoom', 'webex', 'obtenga más información',
    'obtenga mas informacion'
  ].some((blocked) => lowerValue.includes(blocked));
}

function extractTitle(text) {
  const lines = String(text || '').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
  const labelled = lines.find((line) => /^(asunto|subject|título|titulo)\\s*:/i.test(line));

  if (labelled) return cleanTitle(labelled);

  const urlIndex = lines.findIndex((line) => line.includes('https://'));
  const titleCandidates = (urlIndex > 0 ? lines.slice(0, urlIndex) : lines).filter(looksLikeTitle);

  return titleCandidates.length > 0 ? cleanTitle(titleCandidates[0]) : '';
}

function fillMeetingFormFromText(text) {
  const titleInput = $('#addForm [name="title"]');
  const urlInput = $('#addForm [name="url"]');
  const urlMatch = String(text || '').match(/https:\\/\\/[^\\s<>"']+/i);

  if (urlMatch && (urlInput.value.trim() === '' || text === urlInput.value)) {
    urlInput.value = urlMatch[0].replace(/[),.;]+$/, '');
  }

  if (titleInput.value.trim() === '') {
    const extractedTitle = extractTitle(text);
    titleInput.value = extractedTitle || (urlInput.value ? 'Reunión de ' + platformFromUrl(urlInput.value) : '');
  }
}

$$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$('#addForm [name="invite_text"]').addEventListener('input', (event) => fillMeetingFormFromText(event.currentTarget.value));
$('#addForm [name="url"]').addEventListener('input', (event) => {
  const titleInput = $('#addForm [name="title"]');
  if (titleInput.value.trim() === '' && event.currentTarget.value.startsWith('https://')) {
    titleInput.value = 'Reunión de ' + platformFromUrl(event.currentTarget.value);
  }
});
$('#addForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = new FormData(event.currentTarget);
  const endpoint = editingMeetingId ? '/api/meetings/' + editingMeetingId + '/update' : '/api/meetings';
  const result = await api(endpoint, { method: 'POST', body });
  showNotice(result.message);
  if (!result.ok) return;

  resetAddForm();
  setView('home');
  await loadAgenda();
});

const passwordForm = $('#passwordForm');
if (passwordForm) {
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = new FormData(event.currentTarget);
    const result = await api('/api/users/password', { method: 'POST', body });
    showNotice(result.message);
    if (result.ok) event.currentTarget.reset();
  });
}

tick();
setInterval(tick, 1000);
loadAgenda();
setInterval(loadAgenda, 30000);
setView(window.APP_INITIAL_VIEW || 'home');
</script>
</body>
</html>`;
}

