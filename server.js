// server.ts
import express from "express";
import { createServer as createViteServer } from "vite";
import path2 from "path";
import fs2 from "fs";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

// server_orders.ts
import fs from "fs";
import path from "path";
var DATA_DIR = path.resolve(process.cwd(), "data");
var JOURNAL_FILE = path.join(DATA_DIR, "paypal_orders_journal.json");
var memoryCache = /* @__PURE__ */ new Map();
function initializeJournal() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(JOURNAL_FILE)) {
      const raw = fs.readFileSync(JOURNAL_FILE, "utf-8");
      const data = JSON.parse(raw);
      for (const entry of data) {
        memoryCache.set(entry.orderId, entry);
      }
      console.log(`[PayPal Journal] Loaded ${memoryCache.size} orders from persistent storage.`);
    } else {
      fs.writeFileSync(JOURNAL_FILE, JSON.stringify([], null, 2), "utf-8");
    }
  } catch (err) {
    console.error("[PayPal Journal] Failed to initialize storage:", err);
  }
}
function persistToDisk() {
  try {
    const list = Array.from(memoryCache.values());
    const tempFile = `${JOURNAL_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(list, null, 2) + "\n", "utf-8");
    fs.renameSync(tempFile, JOURNAL_FILE);
  } catch (err) {
    console.error("[PayPal Journal] Failed to persist data to disk:", err);
  }
}
initializeJournal();
var ordersJournal = {
  createOrder(entry) {
    const newEntry = {
      ...entry,
      status: "CREATED",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      supabaseSyncStatus: "pending"
    };
    memoryCache.set(newEntry.orderId, newEntry);
    persistToDisk();
    return newEntry;
  },
  getOrder(orderId) {
    return memoryCache.get(orderId);
  },
  /**
   * Atomic lock acquisition to prevent concurrent requests from double-capturing the same order
   */
  claimCaptureLock(orderId) {
    const existing = memoryCache.get(orderId);
    if (!existing) {
      return { success: false, reason: "NOT_FOUND" };
    }
    if (existing.status === "CAPTURED") {
      return { success: false, reason: "ALREADY_CAPTURED" };
    }
    if (existing.status === "CAPTURING") {
      return { success: false, reason: "CONCURRENT_CAPTURE_IN_PROGRESS" };
    }
    existing.status = "CAPTURING";
    memoryCache.set(orderId, existing);
    persistToDisk();
    return { success: true };
  },
  /**
   * Release lock if capture failed or aborted before capture completion
   */
  releaseCaptureLock(orderId, failedReason) {
    const existing = memoryCache.get(orderId);
    if (existing && existing.status === "CAPTURING") {
      existing.status = failedReason ? "FAILED" : "CREATED";
      if (failedReason) {
        existing.supabaseSyncError = failedReason;
      }
      memoryCache.set(orderId, existing);
      persistToDisk();
    }
  },
  markCaptured(orderId, captureId, payerEmail, expiresAt, syncStatus, syncError) {
    const existing = memoryCache.get(orderId);
    if (!existing) {
      throw new Error(`Order ${orderId} not found in journal.`);
    }
    const updated = {
      ...existing,
      status: "CAPTURED",
      capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
      captureId,
      payerEmail,
      expiresAt,
      supabaseSyncStatus: syncStatus,
      supabaseSyncError: syncError
    };
    memoryCache.set(orderId, updated);
    persistToDisk();
    return updated;
  },
  updateSyncStatus(orderId, syncStatus, syncError) {
    const existing = memoryCache.get(orderId);
    if (existing) {
      existing.supabaseSyncStatus = syncStatus;
      existing.supabaseSyncError = syncError;
      memoryCache.set(orderId, existing);
      persistToDisk();
    }
  },
  getPendingSyncOrders() {
    return Array.from(memoryCache.values()).filter(
      (o) => o.status === "CAPTURED" && o.supabaseSyncStatus === "pending"
    );
  },
  getUserOrders(userId) {
    return Array.from(memoryCache.values()).filter((o) => o.userId === userId);
  },
  getAllOrders() {
    return Array.from(memoryCache.values());
  }
};

// server.ts
dotenv.config();
var app = express();
var PORT = Number(process.env.PORT) || 3e3;
var HOST = "0.0.0.0";
app.use(express.json());
var PRESENCE_FILE_PATH = path2.resolve(process.cwd(), "data", "session_presence.json");
function readDisconnectedAuthors() {
  try {
    if (fs2.existsSync(PRESENCE_FILE_PATH)) {
      const raw = fs2.readFileSync(PRESENCE_FILE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.disconnectedAuthorIds)) {
        return new Set(parsed.disconnectedAuthorIds);
      }
    }
  } catch (err) {
    console.warn("Could not read session_presence.json:", err);
  }
  return /* @__PURE__ */ new Set();
}
function writeDisconnectedAuthors(set) {
  try {
    const dir = path2.dirname(PRESENCE_FILE_PATH);
    if (!fs2.existsSync(dir)) {
      fs2.mkdirSync(dir, { recursive: true });
    }
    fs2.writeFileSync(
      PRESENCE_FILE_PATH,
      JSON.stringify({ disconnectedAuthorIds: Array.from(set), updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2) + "\n",
      "utf-8"
    );
  } catch (err) {
    console.warn("Could not write session_presence.json:", err);
  }
}
var disconnectedAuthorIds = readDisconnectedAuthors();
function getServiceRoleKeyStatus() {
  const rawKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!rawKey) {
    return "missing";
  }
  const anonKey = (process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "").trim();
  if (anonKey && rawKey === anonKey || rawKey.startsWith("sb_publishable_") || rawKey.includes("YOUR_SUPABASE") || /\s/.test(rawKey)) {
    return "misconfigured";
  }
  if (rawKey.startsWith("sb_secret_")) {
    return rawKey.length > 20 ? "configured" : "misconfigured";
  }
  const jwtParts = rawKey.split(".");
  if (jwtParts.length === 3) {
    try {
      const payloadJson = Buffer.from(jwtParts[1], "base64url").toString("utf8");
      const payload = JSON.parse(payloadJson);
      if (payload && payload.role === "service_role") {
        return "configured";
      }
      return "misconfigured";
    } catch {
      return "misconfigured";
    }
  }
  return "misconfigured";
}
function isSafePublicSupabaseAnonKey(rawKey) {
  const trimmed = (rawKey || "").trim();
  if (!trimmed || trimmed.includes("YOUR_SUPABASE") || trimmed.startsWith("sb_secret_") || /\s/.test(trimmed)) {
    return false;
  }
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (serviceRoleKey && trimmed === serviceRoleKey) {
    return false;
  }
  const jwtParts = trimmed.split(".");
  if (jwtParts.length === 3) {
    try {
      const payloadJson = Buffer.from(jwtParts[1], "base64url").toString("utf8");
      const payload = JSON.parse(payloadJson);
      if (payload && payload.role === "service_role") {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}
function getPublicSupabaseConfig() {
  const url = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").trim();
  const rawAnon = (process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  const validUrl = Boolean(url && url.startsWith("https://") && !url.includes("YOUR_SUPABASE"));
  const validAnon = isSafePublicSupabaseAnonKey(rawAnon);
  const missingVars = [];
  if (!validUrl) missingVars.push("VITE_SUPABASE_URL");
  if (!validAnon) missingVars.push("VITE_SUPABASE_ANON_KEY");
  return {
    configured: validUrl && validAnon,
    url: validUrl ? url : "",
    anonKey: validAnon ? rawAnon : "",
    missingVars
  };
}
var serverSupabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").trim();
var serverAnonKey = (process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
var serverServiceRoleKey = getServiceRoleKeyStatus() === "configured" ? (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim() : "";
var _serverAuthSupabase = null;
var _serverAdminSupabase = null;
function getServerAuthSupabase() {
  if (_serverAuthSupabase) return _serverAuthSupabase;
  const url = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").trim();
  const anonKey = (process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const key = anonKey || serviceRoleKey;
  if (url && key) {
    _serverAuthSupabase = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    return _serverAuthSupabase;
  }
  return null;
}
function getServerAdminSupabase() {
  if (_serverAdminSupabase && getServiceRoleKeyStatus() === "configured") {
    return _serverAdminSupabase;
  }
  const url = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (url && getServiceRoleKeyStatus() === "configured" && serviceRoleKey) {
    _serverAdminSupabase = createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    return _serverAdminSupabase;
  }
  return null;
}
var serverAuthSupabase = serverSupabaseUrl && (serverAnonKey || serverServiceRoleKey) ? createClient(serverSupabaseUrl, serverAnonKey || serverServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
}) : null;
var serverAdminSupabase = serverSupabaseUrl && serverServiceRoleKey ? createClient(serverSupabaseUrl, serverServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
}) : null;
var serverSupabase = serverAdminSupabase;
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Autenticaci\xF3n requerida: falta cabecera Bearer token." });
    return;
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    res.status(401).json({ error: "Token de autenticaci\xF3n no proporcionado." });
    return;
  }
  const authClient = getServerAuthSupabase() || serverAuthSupabase;
  if (!authClient) {
    res.status(503).json({ error: "Servicio de autenticaci\xF3n no configurado en el servidor." });
    return;
  }
  try {
    const { data: { user }, error } = await authClient.auth.getUser(token);
    if (error || !user) {
      res.status(401).json({ error: "Token de sesi\xF3n expirado o inv\xE1lido." });
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    console.error("Error verifying Supabase JWT in requireAuth:", err);
    res.status(500).json({ error: "Error interno verificando la sesi\xF3n del usuario." });
  }
}
async function checkIsServerVerifiedAdmin(user) {
  if (!user || !user.id) {
    return false;
  }
  if (user.app_metadata?.role === "admin") {
    return true;
  }
  if (serverAdminSupabase) {
    try {
      const { data: profile, error } = await serverAdminSupabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
      if (!error && profile && profile.role === "admin") {
        return true;
      }
    } catch {
    }
  }
  if (process.env.ADMIN_EMAILS && user.email) {
    const adminEmails = process.env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (adminEmails.includes(user.email.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}
function isValidServiceId(rawId) {
  if (typeof rawId !== "string") return false;
  const trimmed = rawId.trim();
  if (trimmed.length < 1 || trimmed.length > 128) return false;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}
async function requireAdmin(req, res, next) {
  const user = req.user;
  if (!user || !user.id) {
    res.status(401).json({ error: "Autenticaci\xF3n requerida para acceder al \xE1rea de administraci\xF3n." });
    return;
  }
  const isAdmin = await checkIsServerVerifiedAdmin(user);
  if (!isAdmin) {
    res.status(403).json({
      error: "Acceso denegado: se requieren permisos administrativos verificados en el servidor."
    });
    return;
  }
  next();
}
function getPayPalRuntime() {
  let devEnv = {};
  if (fs2.existsSync("/app/.dev.env.json")) {
    try {
      devEnv = JSON.parse(fs2.readFileSync("/app/.dev.env.json", "utf8")) || {};
    } catch {
      devEnv = {};
    }
  }
  const rawClientId = process.env.PAYPAL_CLIENT_ID || devEnv.PAYPAL_CLIENT_ID || "";
  const rawClientSecret = process.env.PAYPAL_CLIENT_SECRET || devEnv.PAYPAL_CLIENT_SECRET || "";
  const rawEnv = process.env.PAYPAL_ENVIRONMENT || devEnv.PAYPAL_ENVIRONMENT || "";
  const sanitize = (val) => typeof val === "string" ? val.trim().replace(/^['"]|['"]$/g, "") : "";
  const clientId = sanitize(rawClientId);
  const clientSecret = sanitize(rawClientSecret);
  const envVal = sanitize(rawEnv).toLowerCase();
  const isLive = envVal === "live" || envVal === "production";
  const environment = isLive ? "live" : "sandbox";
  const apiBase = isLive ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const clientIdConfigured = Boolean(clientId && clientId.length > 5);
  const clientSecretConfigured = Boolean(clientSecret && clientSecret.length > 5);
  const isConfigured = clientIdConfigured && clientSecretConfigured;
  let credentialsSource = "none";
  const fromProc = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
  const fromDev = Boolean(devEnv.PAYPAL_CLIENT_ID && devEnv.PAYPAL_CLIENT_SECRET);
  if (fromProc && fromDev) credentialsSource = "process.env";
  else if (fromProc) credentialsSource = "process.env";
  else if (fromDev) credentialsSource = "dev.env.json";
  else if (clientIdConfigured || clientSecretConfigured) credentialsSource = "mixed";
  let status = "ready";
  let message = "";
  if (isConfigured) {
    status = "ready";
    message = `Credenciales de PayPal operativas y conectadas en modo ${environment.toUpperCase()}.`;
  } else if (!clientIdConfigured && !clientSecretConfigured) {
    status = "missing_credentials";
    message = "Credenciales ausentes: se requieren PAYPAL_CLIENT_ID y PAYPAL_CLIENT_SECRET en el servidor.";
  } else if (!clientIdConfigured) {
    status = "missing_client_id";
    message = "Falta configurar PAYPAL_CLIENT_ID en el servidor.";
  } else {
    status = "missing_client_secret";
    message = "Falta configurar PAYPAL_CLIENT_SECRET en el servidor.";
  }
  return {
    isConfigured,
    clientId: clientIdConfigured ? clientId : null,
    clientSecret: clientSecretConfigured ? clientSecret : null,
    environment,
    apiBase,
    diagnostics: {
      clientIdConfigured,
      clientSecretConfigured,
      environment,
      credentialsSource,
      clientIdLength: clientId.length,
      clientSecretLength: clientSecret.length,
      status,
      message
    }
  };
}
app.get("/api/health", (_req, res) => {
  const hasSupabaseUrl = Boolean(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL);
  const hasSupabaseAnonKey = Boolean(process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY);
  const serviceRoleKeyStatus = getServiceRoleKeyStatus();
  const hasServiceRoleKey = serviceRoleKeyStatus === "configured";
  const ppRuntime = getPayPalRuntime();
  res.json({
    status: "healthy",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || "development",
    configuration: {
      supabaseUrlConfigured: hasSupabaseUrl,
      supabaseAnonKeyConfigured: hasSupabaseAnonKey,
      supabaseServiceRoleKeyConfigured: hasServiceRoleKey,
      supabaseServiceRoleKeyStatus: serviceRoleKeyStatus,
      paypalClientIdConfigured: ppRuntime.diagnostics.clientIdConfigured,
      paypalClientSecretConfigured: ppRuntime.diagnostics.clientSecretConfigured,
      paypalEnvironment: ppRuntime.environment,
      paypalStatus: ppRuntime.diagnostics.status
    }
  });
});
app.get("/api/supabase/config", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(getPublicSupabaseConfig());
});
app.get("/api/supabase/public-env.js", (_req, res) => {
  const pub = getPublicSupabaseConfig();
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(`window.__VECINOYA_SUPABASE_CONFIG__ = ${JSON.stringify(pub)};
`);
});
app.get("/api/auth/admin-status", requireAuth, async (req, res) => {
  const authUser = req.user;
  if (!authUser || !authUser.id) {
    res.status(401).json({ error: "Sesi\xF3n no v\xE1lida." });
    return;
  }
  const isAdmin = await checkIsServerVerifiedAdmin(authUser);
  res.json({ isAdmin: Boolean(isAdmin) });
});
app.get("/api/session/presence", (_req, res) => {
  res.json({
    disconnectedAuthorIds: Array.from(disconnectedAuthorIds)
  });
});
app.post("/api/session/presence", requireAuth, async (req, res) => {
  const authUser = req.user;
  if (!authUser || !authUser.id) {
    res.status(401).json({ error: "Sesi\xF3n no v\xE1lida." });
    return;
  }
  const isOnline = Boolean(req.body?.online);
  if (isOnline) {
    disconnectedAuthorIds.delete(authUser.id);
  } else {
    disconnectedAuthorIds.add(authUser.id);
  }
  writeDisconnectedAuthors(disconnectedAuthorIds);
  res.json({
    success: true,
    userId: authUser.id,
    online: isOnline,
    disconnectedAuthorIds: Array.from(disconnectedAuthorIds)
  });
});
app.patch("/api/admin/services/:serviceId/status", requireAuth, requireAdmin, async (req, res) => {
  const authUser = req.user;
  if (!authUser || !authUser.id) {
    res.status(401).json({ error: "Autenticaci\xF3n requerida." });
    return;
  }
  if (!serverSupabase || getServiceRoleKeyStatus() !== "configured") {
    res.status(503).json({
      error: "Moderaci\xF3n administrativa no disponible: el cliente privilegiado de Supabase no est\xE1 configurado v\xE1lidamente en el servidor."
    });
    return;
  }
  const rawServiceId = req.params.serviceId;
  if (!isValidServiceId(rawServiceId)) {
    res.status(400).json({ error: "Identificador de anuncio inv\xE1lido." });
    return;
  }
  const serviceId = rawServiceId.trim();
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ error: "Cuerpo de solicitud inv\xE1lido." });
    return;
  }
  const bodyKeys = Object.keys(req.body);
  if (bodyKeys.length !== 1 || bodyKeys[0] !== "status") {
    res.status(400).json({
      error: "Solicitud rechazada: esta ruta solo permite actualizar la columna status."
    });
    return;
  }
  const nextStatus = req.body.status;
  if (nextStatus !== "active" && nextStatus !== "suspended") {
    res.status(400).json({
      error: "Valor de status inv\xE1lido: solo se permite 'active' o 'suspended'."
    });
    return;
  }
  try {
    const { data: existingService, error: fetchError } = await serverSupabase.from("services").select("id, author_id, status").eq("id", serviceId).maybeSingle();
    if (fetchError) {
      res.status(502).json({
        error: `Error al consultar el anuncio en Supabase (${fetchError.code || "DB_ERROR"}): ${fetchError.message}`
      });
      return;
    }
    if (!existingService) {
      res.status(404).json({ error: "El anuncio especificado no existe en Supabase." });
      return;
    }
    if (existingService.status === "draft" && nextStatus === "active") {
      res.status(400).json({
        error: "Operaci\xF3n no permitida: moderaci\xF3n no puede publicar como activo un borrador privado (draft)."
      });
      return;
    }
    const { data: updatedRows, error: updateError } = await serverSupabase.from("services").update({ status: nextStatus }).eq("id", serviceId).select("id, status, author_id");
    if (updateError) {
      res.status(502).json({
        error: `No se pudo actualizar el estado del anuncio en Supabase (${updateError.code || "DB_ERROR"}): ${updateError.message}`
      });
      return;
    }
    if (!updatedRows || updatedRows.length !== 1 || updatedRows[0].status !== nextStatus) {
      res.status(500).json({
        error: "No se pudo confirmar la actualizaci\xF3n de estado del anuncio en Supabase."
      });
      return;
    }
    res.json({
      success: true,
      serviceId: updatedRows[0].id,
      status: updatedRows[0].status,
      authorId: updatedRows[0].author_id
    });
  } catch (err) {
    res.status(500).json({
      error: err?.message || "Error interno del servidor al actualizar el estado del anuncio."
    });
  }
});
app.delete("/api/admin/services/:serviceId", requireAuth, requireAdmin, async (req, res) => {
  const authUser = req.user;
  if (!authUser || !authUser.id) {
    res.status(401).json({ error: "Autenticaci\xF3n requerida." });
    return;
  }
  if (!serverSupabase || getServiceRoleKeyStatus() !== "configured") {
    res.status(503).json({
      error: "Moderaci\xF3n administrativa no disponible: el cliente privilegiado de Supabase no est\xE1 configurado v\xE1lidamente en el servidor."
    });
    return;
  }
  const rawServiceId = req.params.serviceId;
  if (!isValidServiceId(rawServiceId)) {
    res.status(400).json({ error: "Identificador de anuncio inv\xE1lido." });
    return;
  }
  const serviceId = rawServiceId.trim();
  try {
    const { data: existingService, error: fetchError } = await serverSupabase.from("services").select("id, author_id").eq("id", serviceId).maybeSingle();
    if (fetchError) {
      res.status(502).json({
        error: `Error al verificar el anuncio en Supabase (${fetchError.code || "DB_ERROR"}): ${fetchError.message}`
      });
      return;
    }
    if (!existingService) {
      res.status(404).json({ error: "El anuncio que intentas eliminar no existe en Supabase." });
      return;
    }
    const { data: deletedRows, error: deleteError } = await serverSupabase.from("services").delete().eq("id", serviceId).select("id");
    if (deleteError) {
      res.status(502).json({
        error: `Error al eliminar el anuncio en Supabase (${deleteError.code || "DB_ERROR"}): ${deleteError.message}`
      });
      return;
    }
    if (!deletedRows || deletedRows.length !== 1) {
      const { data: stillExists } = await serverSupabase.from("services").select("id").eq("id", serviceId).maybeSingle();
      if (stillExists) {
        res.status(500).json({
          error: "No se pudo confirmar la eliminaci\xF3n del anuncio en Supabase."
        });
        return;
      }
    }
    res.json({
      success: true,
      deletedId: serviceId,
      authorId: existingService.author_id
    });
  } catch (err) {
    res.status(500).json({
      error: err?.message || "Error interno del servidor al eliminar el anuncio."
    });
  }
});
var OFFICIAL_BOOST_PLANS = {
  basico: {
    name: "Plan B\xE1sico",
    price: 1.5,
    durationDays: 3
  },
  intermedio: {
    name: "Plan Intermedio",
    price: 3,
    durationDays: 7
  },
  avanzado: {
    name: "Plan Avanzado",
    price: 5,
    durationDays: 15
  },
  premium: {
    name: "Plan Premium",
    price: 8,
    durationDays: 30
  }
};
async function getPayPalAccessToken() {
  const runtime = getPayPalRuntime();
  if (!runtime.isConfigured || !runtime.clientId || !runtime.clientSecret) {
    throw new Error("MISSING_CREDENTIALS");
  }
  const auth = Buffer.from(`${runtime.clientId}:${runtime.clientSecret}`).toString("base64");
  const response = await fetch(`${runtime.apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[PayPal OAuth Error] Status: ${response.status}, Mode: ${runtime.environment}, Details:`, errorText);
    if (response.status === 401) {
      throw new Error(
        `Error de autenticaci\xF3n con PayPal (401 en modo ${runtime.environment.toUpperCase()}): comprueba que tus credenciales correspondan al entorno configurado en PAYPAL_ENVIRONMENT.`
      );
    }
    throw new Error(`PayPal auth failed with status ${response.status} in mode ${runtime.environment.toUpperCase()}`);
  }
  const data = await response.json();
  return data.access_token;
}
async function getPayPalOrderDetails(orderId, accessToken) {
  const runtime = getPayPalRuntime();
  try {
    const res = await fetch(`${runtime.apiBase}/v2/checkout/orders/${orderId}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    if (res.ok) {
      return await res.json();
    }
    return null;
  } catch (err) {
    console.error("Error fetching PayPal order details:", err);
    return null;
  }
}
app.get("/api/paypal/config", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  const runtime = getPayPalRuntime();
  res.json({
    configured: runtime.isConfigured,
    clientId: runtime.clientId,
    environment: runtime.environment,
    currency: "EUR",
    officialPlans: OFFICIAL_BOOST_PLANS,
    diagnostics: runtime.diagnostics
  });
});
app.post("/api/paypal/create-order", requireAuth, async (req, res) => {
  try {
    const authUser = req.user;
    if (!authUser || !authUser.id) {
      res.status(401).json({ error: "Usuario no autenticado en Supabase." });
      return;
    }
    const adminClient = getServerAdminSupabase() || serverAdminSupabase;
    if (!adminClient || getServiceRoleKeyStatus() !== "configured") {
      res.status(503).json({
        error: "Las promociones de pago no est\xE1n disponibles temporalmente: falta configurar SUPABASE_SERVICE_ROLE_KEY en el servidor para verificar y activar anuncios."
      });
      return;
    }
    const { planId, serviceId } = req.body || {};
    if (!planId || typeof planId !== "string" || !OFFICIAL_BOOST_PLANS[planId]) {
      res.status(400).json({ error: "Plan de destacado inv\xE1lido o no reconocido." });
      return;
    }
    if (!isValidServiceId(serviceId)) {
      res.status(400).json({ error: "Identificador del servicio a destacar inv\xE1lido o ausente." });
      return;
    }
    const normalizedServiceId = serviceId.trim();
    const activeCapturingOrder = ordersJournal.getUserOrders(authUser.id).find((o) => o.serviceId === normalizedServiceId && o.status === "CAPTURING");
    if (activeCapturingOrder) {
      res.status(409).json({
        error: "Ya existe una captura de pago en curso para este anuncio. Espera unos segundos."
      });
      return;
    }
    const { data: srvRow, error: srvError } = await adminClient.from("services").select("id, author_id, status, title").eq("id", normalizedServiceId).maybeSingle();
    if (srvError) {
      res.status(502).json({
        error: `No se pudo verificar el anuncio en Supabase (${srvError.code || "DB_ERROR"}): ${srvError.message}`
      });
      return;
    }
    if (!srvRow) {
      res.status(404).json({
        error: "El anuncio que intentas promocionar no existe en Supabase (public.services)."
      });
      return;
    }
    if (srvRow.author_id !== authUser.id) {
      res.status(403).json({
        error: "Acceso denegado: solo el propietario autenticado puede promocionar su propio anuncio."
      });
      return;
    }
    if (srvRow.status !== "active") {
      res.status(400).json({
        error: "Solo se pueden promocionar anuncios publicados y activos. No es posible destacar borradores ni anuncios suspendidos."
      });
      return;
    }
    const plan = OFFICIAL_BOOST_PLANS[planId];
    const amountStr = plan.price.toFixed(2);
    const accessToken = await getPayPalAccessToken();
    const orderPayload = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: `${normalizedServiceId}#${planId}`,
          custom_id: JSON.stringify({ userId: authUser.id, serviceId: normalizedServiceId, planId }),
          description: `VecinoYa - ${plan.name} (${plan.durationDays} d\xEDas)`,
          amount: {
            currency_code: "EUR",
            value: amountStr
          }
        }
      ],
      application_context: {
        brand_name: "VecinoYa",
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW"
      }
    };
    const runtime = getPayPalRuntime();
    const orderResponse = await fetch(`${runtime.apiBase}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(orderPayload)
    });
    const orderData = await orderResponse.json();
    if (!orderResponse.ok || !orderData.id) {
      console.error("PayPal create order failure:", orderData);
      res.status(orderResponse.status || 500).json({
        error: orderData.message || (runtime.environment === "live" ? "Error al crear la orden en PayPal." : "Error al crear la orden en PayPal Sandbox.")
      });
      return;
    }
    ordersJournal.createOrder({
      orderId: orderData.id,
      userId: authUser.id,
      userEmail: authUser.email,
      userName: authUser.user_metadata?.name || authUser.email?.split("@")[0] || "Vecino",
      serviceId: normalizedServiceId,
      serviceTitle: srvRow.title || "Servicio VecinoYa",
      planId,
      planName: plan.name,
      amount: plan.price,
      currency: "EUR",
      durationDays: plan.durationDays
    });
    res.json({
      orderId: orderData.id,
      status: orderData.status,
      planName: plan.name,
      amount: amountStr,
      currency: "EUR"
    });
  } catch (error) {
    const runtime = getPayPalRuntime();
    if (error.message === "MISSING_CREDENTIALS") {
      res.status(503).json({
        error: runtime.environment === "live" ? "Las credenciales de PayPal LIVE no est\xE1n configuradas en el servidor." : "Las credenciales de PayPal Sandbox no est\xE1n configuradas en el servidor."
      });
      return;
    }
    console.error("Error in /api/paypal/create-order:", error);
    res.status(500).json({ error: error.message || "Error interno del servidor al procesar la orden." });
  }
});
app.post("/api/paypal/capture-order", requireAuth, async (req, res) => {
  try {
    const authUser = req.user;
    if (!authUser || !authUser.id) {
      res.status(401).json({ error: "Usuario no autenticado en Supabase." });
      return;
    }
    const { orderId } = req.body || {};
    if (!orderId || typeof orderId !== "string") {
      res.status(400).json({ error: "Identificador de orden de PayPal no proporcionado." });
      return;
    }
    const storedOrder = ordersJournal.getOrder(orderId);
    if (!storedOrder) {
      res.status(400).json({
        error: "Orden no encontrada o no originada v\xE1lidamente en este servidor."
      });
      return;
    }
    if (storedOrder.userId !== authUser.id) {
      res.status(403).json({
        error: "Acceso no autorizado: la orden de pago pertenece a otra cuenta de usuario."
      });
      return;
    }
    if (storedOrder.status === "CAPTURED") {
      res.json({
        success: true,
        idempotentReplay: true,
        orderId: storedOrder.orderId,
        captureId: storedOrder.captureId,
        status: "COMPLETED",
        serviceId: storedOrder.serviceId,
        serviceTitle: storedOrder.serviceTitle,
        planId: storedOrder.planId,
        planName: storedOrder.planName,
        durationDays: storedOrder.durationDays,
        amount: storedOrder.amount,
        currency: "EUR",
        createdAt: storedOrder.createdAt,
        expiresAt: storedOrder.expiresAt,
        supabaseSyncStatus: storedOrder.supabaseSyncStatus
      });
      return;
    }
    if (!serverAdminSupabase || getServiceRoleKeyStatus() !== "configured") {
      res.status(503).json({
        error: "No se puede procesar la captura: SUPABASE_SERVICE_ROLE_KEY no est\xE1 configurado v\xE1lidamente en el servidor."
      });
      return;
    }
    const lockResult = ordersJournal.claimCaptureLock(orderId);
    if (!lockResult.success) {
      if (lockResult.reason === "ALREADY_CAPTURED") {
        const captured = ordersJournal.getOrder(orderId);
        res.json({
          success: true,
          idempotentReplay: true,
          orderId: captured?.orderId,
          captureId: captured?.captureId,
          status: "COMPLETED",
          serviceId: captured?.serviceId,
          serviceTitle: captured?.serviceTitle,
          planId: captured?.planId,
          planName: captured?.planName,
          durationDays: captured?.durationDays,
          amount: captured?.amount,
          currency: "EUR",
          createdAt: captured?.createdAt,
          expiresAt: captured?.expiresAt,
          supabaseSyncStatus: captured?.supabaseSyncStatus
        });
        return;
      }
      res.status(409).json({
        error: "Procesamiento concurrente detectado: la captura de esta orden ya est\xE1 en progreso en el servidor."
      });
      return;
    }
    const plan = OFFICIAL_BOOST_PLANS[storedOrder.planId];
    if (!plan) {
      ordersJournal.releaseCaptureLock(orderId, "PLAN_INVALIDO");
      res.status(400).json({ error: "Plan de destacado inv\xE1lido en la orden registrada." });
      return;
    }
    const { data: preCheckService, error: preCheckErr } = await serverAdminSupabase.from("services").select("id, author_id, status").eq("id", storedOrder.serviceId).maybeSingle();
    if (preCheckErr) {
      ordersJournal.releaseCaptureLock(orderId, void 0);
      res.status(502).json({
        error: `No se pudo verificar el estado del anuncio en Supabase antes de capturar el pago: ${preCheckErr.message}`
      });
      return;
    }
    if (!preCheckService) {
      ordersJournal.releaseCaptureLock(orderId, "SERVICE_NOT_FOUND");
      res.status(404).json({
        error: "El anuncio asociado a esta orden ya no existe en Supabase. No se ha realizado ning\xFAn cargo."
      });
      return;
    }
    if (preCheckService.author_id !== storedOrder.userId) {
      ordersJournal.releaseCaptureLock(orderId, "OWNER_MISMATCH");
      res.status(403).json({
        error: "La titularidad del anuncio no coincide con el usuario de la orden. No se ha realizado ning\xFAn cargo."
      });
      return;
    }
    if (preCheckService.status !== "active") {
      ordersJournal.releaseCaptureLock(orderId, "SERVICE_NOT_ACTIVE");
      res.status(400).json({
        error: "El anuncio no se encuentra activo (est\xE1 en borrador o suspendido). No se ha realizado ning\xFAn cargo."
      });
      return;
    }
    let accessToken;
    try {
      accessToken = await getPayPalAccessToken();
    } catch (tokenErr) {
      ordersJournal.releaseCaptureLock(orderId, void 0);
      throw tokenErr;
    }
    let captureResponse;
    const runtime = getPayPalRuntime();
    try {
      captureResponse = await fetch(`${runtime.apiBase}/v2/checkout/orders/${orderId}/capture`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      });
    } catch (netErr) {
      ordersJournal.releaseCaptureLock(orderId, void 0);
      throw netErr;
    }
    let captureData = await captureResponse.json();
    const isAlreadyCapturedInPayPal = captureData?.name === "ORDER_ALREADY_CAPTURED" || captureData?.details?.some((d) => d.issue === "ORDER_ALREADY_CAPTURED");
    if (!captureResponse.ok && isAlreadyCapturedInPayPal) {
      console.warn(`[PayPal Recovery] Orden ${orderId} ya figuraba capturada en PayPal. Consultando estado...`);
      const existingOrderInfo = await getPayPalOrderDetails(orderId, accessToken);
      if (existingOrderInfo && existingOrderInfo.status === "COMPLETED") {
        captureData = existingOrderInfo;
      }
    }
    if (!captureResponse.ok && !isAlreadyCapturedInPayPal || captureData.status !== "COMPLETED") {
      console.error("PayPal capture failure:", captureData);
      ordersJournal.releaseCaptureLock(orderId, captureData.message || "PAYPAL_CAPTURE_REJECTED");
      res.status(captureResponse.status || 400).json({
        error: captureData.message || `La captura no se complet\xF3 (Estado: ${captureData.status || "FALLIDO"}).`
      });
      return;
    }
    const purchaseUnit = captureData.purchase_units?.[0];
    const captureDetail = purchaseUnit?.payments?.captures?.[0];
    if (!captureDetail || captureDetail.status !== "COMPLETED") {
      ordersJournal.releaseCaptureLock(orderId, "CAPTURE_DETAIL_NOT_COMPLETED");
      res.status(400).json({
        error: `El cobro en PayPal no figura como COMPLETED en el detalle de captura (Estado: ${captureDetail?.status || "DESCONOCIDO"}).`
      });
      return;
    }
    const capturedAmount = parseFloat(captureDetail?.amount?.value || "0");
    const capturedCurrency = captureDetail?.amount?.currency_code;
    if (capturedCurrency !== "EUR" || Math.abs(capturedAmount - storedOrder.amount) > 0.01) {
      console.error("Monto o moneda capturada no coincide:", {
        capturedAmount,
        capturedCurrency,
        expected: storedOrder.amount
      });
      ordersJournal.releaseCaptureLock(orderId, "AMOUNT_MISMATCH");
      res.status(400).json({
        error: "El importe o la divisa verificados en PayPal no coinciden con las especificaciones del plan del servidor."
      });
      return;
    }
    const expectedReferenceId = `${storedOrder.serviceId}#${storedOrder.planId}`;
    if (purchaseUnit?.reference_id && purchaseUnit.reference_id !== expectedReferenceId) {
      ordersJournal.releaseCaptureLock(orderId, "REFERENCE_ID_MISMATCH");
      res.status(400).json({
        error: "La referencia del servicio/plan en la orden de PayPal no coincide con la orden registrada."
      });
      return;
    }
    const rawCustomId = captureDetail?.custom_id || purchaseUnit?.custom_id;
    if (rawCustomId && typeof rawCustomId === "string") {
      try {
        const parsedCustom = JSON.parse(rawCustomId);
        if (parsedCustom.userId !== storedOrder.userId || parsedCustom.serviceId !== storedOrder.serviceId || parsedCustom.planId !== storedOrder.planId) {
          ordersJournal.releaseCaptureLock(orderId, "CUSTOM_ID_MISMATCH");
          res.status(400).json({
            error: "Los metadatos de auditor\xEDa (custom_id) de PayPal no coinciden con la orden del servidor."
          });
          return;
        }
      } catch {
        ordersJournal.releaseCaptureLock(orderId, "CUSTOM_ID_INVALID");
        res.status(400).json({
          error: "Formato inv\xE1lido en los metadatos custom_id devueltos por PayPal."
        });
        return;
      }
    }
    const now = /* @__PURE__ */ new Date();
    const expiresAt = new Date(now.getTime() + storedOrder.durationDays * 864e5).toISOString();
    const captureId = captureDetail?.id || orderId;
    const payerEmail = captureData.payer?.email_address || void 0;
    let syncStatus = "pending";
    let syncError = void 0;
    try {
      const srvRes = await serverAdminSupabase.from("services").update({
        is_featured: true,
        featured_plan_id: storedOrder.planId,
        featured_plan_name: storedOrder.planName,
        featured_until: expiresAt
      }).eq("id", storedOrder.serviceId).eq("author_id", storedOrder.userId).eq("status", "active").select("id, status, is_featured, featured_plan_id, featured_plan_name, featured_until");
      const serviceUpdated = !srvRes.error && Array.isArray(srvRes.data) && srvRes.data.length === 1 && srvRes.data[0].is_featured === true && srvRes.data[0].featured_plan_id === storedOrder.planId && Boolean(srvRes.data[0].featured_until);
      if (serviceUpdated) {
        syncStatus = "synced";
      } else {
        syncError = srvRes.error?.message || "No se pudo confirmar la actualizaci\xF3n de 1 fila activa en public.services tras la captura.";
        syncStatus = "pending";
      }
    } catch (dbErr) {
      syncError = dbErr.message || "Excepci\xF3n comunicando con Supabase";
      syncStatus = "pending";
    }
    const capturedOrder = ordersJournal.markCaptured(
      orderId,
      captureId,
      payerEmail,
      expiresAt,
      syncStatus,
      syncError
    );
    res.json({
      success: true,
      orderId,
      captureId,
      status: "COMPLETED",
      serviceId: storedOrder.serviceId,
      serviceTitle: storedOrder.serviceTitle,
      planId: storedOrder.planId,
      planName: storedOrder.planName,
      durationDays: storedOrder.durationDays,
      amount: storedOrder.amount,
      currency: "EUR",
      createdAt: now.toISOString(),
      expiresAt,
      payerEmail,
      supabaseSyncStatus: capturedOrder.supabaseSyncStatus
    });
  } catch (error) {
    if (error.message === "MISSING_CREDENTIALS") {
      res.status(503).json({
        error: "Credenciales de PayPal Sandbox no configuradas en el servidor."
      });
      return;
    }
    console.error("Error in /api/paypal/capture-order:", error);
    res.status(500).json({ error: error.message || "Error al capturar la orden de PayPal." });
  }
});
app.get("/api/paypal/my-transactions", requireAuth, (req, res) => {
  const authUser = req.user;
  const userOrders = ordersJournal.getUserOrders(authUser.id);
  res.json({ transactions: userOrders });
});
app.post("/api/admin/reconcile-pending", requireAuth, requireAdmin, async (_req, res) => {
  if (!serverAdminSupabase || getServiceRoleKeyStatus() !== "configured") {
    res.status(503).json({
      error: "Conciliaci\xF3n no disponible: SUPABASE_SERVICE_ROLE_KEY no est\xE1 configurado v\xE1lidamente en el servidor."
    });
    return;
  }
  const pending = ordersJournal.getPendingSyncOrders();
  const results = [];
  for (const order of pending) {
    try {
      const targetExpiresAt = order.expiresAt || new Date(Date.now() + order.durationDays * 864e5).toISOString();
      const { data: srvData, error: srvErr } = await serverAdminSupabase.from("services").update({
        is_featured: true,
        featured_plan_id: order.planId,
        featured_plan_name: order.planName,
        featured_until: targetExpiresAt
      }).eq("id", order.serviceId).eq("author_id", order.userId).eq("status", "active").select("id, status, is_featured, featured_plan_id, featured_until");
      const serviceUpdated = !srvErr && Array.isArray(srvData) && srvData.length === 1 && srvData[0].is_featured === true && srvData[0].featured_plan_id === order.planId && Boolean(srvData[0].featured_until);
      if (serviceUpdated) {
        ordersJournal.updateSyncStatus(order.orderId, "synced");
        results.push({ orderId: order.orderId, status: "synced", method: "direct_services_update" });
      } else {
        results.push({
          orderId: order.orderId,
          status: "failed",
          error: srvErr?.message || "El anuncio no existe, no est\xE1 activo o no pertenece al comprador."
        });
      }
    } catch (err) {
      results.push({ orderId: order.orderId, status: "exception", error: err.message });
    }
  }
  res.json({
    totalPending: pending.length,
    reconciledCount: results.filter((r) => r.status === "synced").length,
    results
  });
});
async function startServer() {
  const isProduction = process.env.NODE_ENV === "production";
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path2.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path2.resolve(distPath, "index.html"));
    });
  }
  app.listen(PORT, HOST, () => {
    console.log(`[VecinoYa Full-Stack Server] running on http://${HOST}:${PORT}`);
  });
}
startServer().catch((err) => {
  console.error("Failed to start VecinoYa server:", err);
  process.exit(1);
});
export {
  getServerAdminSupabase,
  getServerAuthSupabase,
  requireAdmin,
  requireAuth,
  serverAdminSupabase,
  serverAuthSupabase,
  serverSupabase
};
