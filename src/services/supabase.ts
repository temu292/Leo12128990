import { createClient, SupabaseClient, User as SupabaseAuthUser, Session } from '@supabase/supabase-js';
import { ServiceListing, User, UserProfileUpdate } from '../types';

interface RuntimePublicSupabaseConfig {
  configured?: boolean;
  url?: string;
  anonKey?: string;
  missingVars?: string[];
}

declare global {
  interface Window {
    __VECINOYA_SUPABASE_CONFIG__?: RuntimePublicSupabaseConfig;
  }
}

function isValidClientAnonKey(rawKey: string): boolean {
  const trimmed = (rawKey || '').trim();
  if (!trimmed || trimmed.includes('YOUR_SUPABASE') || trimmed.startsWith('sb_secret_') || /\s/.test(trimmed)) {
    return false;
  }
  const parts = trimmed.split('.');
  if (parts.length === 3) {
    try {
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(base64));
      if (payload && payload.role === 'service_role') {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function resolveInitialPublicConfig(): { url: string; anonKey: string; missingVars: string[] } {
  const runtimeCfg =
    typeof window !== 'undefined' ? window.__VECINOYA_SUPABASE_CONFIG__ : undefined;

  const rawUrl = (
    import.meta.env.VITE_SUPABASE_URL ||
    runtimeCfg?.url ||
    ''
  ).trim();
  const rawAnonKey = (
    import.meta.env.VITE_SUPABASE_ANON_KEY ||
    runtimeCfg?.anonKey ||
    ''
  ).trim();

  const validUrl = Boolean(rawUrl && rawUrl.startsWith('https://') && !rawUrl.includes('YOUR_SUPABASE'));
  const validAnonKey = isValidClientAnonKey(rawAnonKey);

  const missingVars: string[] = [];
  if (!validUrl) missingVars.push('VITE_SUPABASE_URL');
  if (!validAnonKey) missingVars.push('VITE_SUPABASE_ANON_KEY');

  return {
    url: validUrl ? rawUrl : '',
    anonKey: validAnonKey ? rawAnonKey : '',
    missingVars
  };
}

export interface PasswordRecoveryState {
  isRecovery: boolean;
  error: string | null;
}

interface InitialAuthUrlSnapshot {
  isRecoveryIntent: boolean;
  tokenHash: string | null;
  authCode: string | null;
  hasAccessTokenInHash: boolean;
  error: string | null;
  errorCode: string | null;
  errorDescription: string | null;
}

const RECOVERY_PENDING_STORAGE_KEY = 'vecinoya_recovery_pending_v1';
const RECOVERY_COMPLETED_TS_KEY = 'vecinoya_recovery_completed_ts_v1';

function parseUrlParamsSnapshot(): InitialAuthUrlSnapshot {
  if (typeof window === 'undefined') {
    return {
      isRecoveryIntent: false,
      tokenHash: null,
      authCode: null,
      hasAccessTokenInHash: false,
      error: null,
      errorCode: null,
      errorDescription: null
    };
  }

  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  // Support hashes that may start with a leading slash or query (e.g. #/?type=recovery or #access_token=...)
  const normalizedHash = rawHash.startsWith('?')
    ? rawHash.slice(1)
    : rawHash.includes('?') && !rawHash.includes('=')
      ? rawHash.split('?').slice(1).join('&')
      : rawHash;

  const hashParams = new URLSearchParams(normalizedHash);
  const searchParams = new URLSearchParams(window.location.search);

  const getParam = (key: string): string | null => {
    return hashParams.get(key) || searchParams.get(key);
  };

  const typeParam = (getParam('type') || '').toLowerCase();
  const tokenHash = getParam('token_hash') || (typeParam === 'recovery' ? getParam('token') : null);
  const authCode = searchParams.get('code') || hashParams.get('code');
  const hasAccessTokenInHash = Boolean(hashParams.get('access_token'));
  const error = getParam('error');
  const errorCode = getParam('error_code');
  const errorDescription = getParam('error_description');

  const isRecoveryIntent =
    typeParam === 'recovery' ||
    Boolean(tokenHash && typeParam === 'recovery') ||
    searchParams.get('recovery') === '1';

  if (isRecoveryIntent && !error && !errorCode) {
    try {
      window.sessionStorage.setItem(RECOVERY_PENDING_STORAGE_KEY, 'true');
    } catch {
      // ignore storage errors
    }
  }

  return {
    isRecoveryIntent,
    tokenHash,
    authCode,
    hasAccessTokenInHash,
    error,
    errorCode,
    errorDescription
  };
}

// Capture URL parameters immediately at module load BEFORE createClient() clears window.location.hash
const initialUrlSnapshot: InitialAuthUrlSnapshot = parseUrlParamsSnapshot();

export function translateSupabaseRecoveryError(
  rawMessage?: string | null,
  errorCode?: string | null
): string {
  const code = (errorCode || '').toLowerCase();
  const msg = (rawMessage || '').trim();
  const lower = msg.toLowerCase();

  if (
    code === 'otp_expired' ||
    lower.includes('expired') ||
    lower.includes('invalid or has expired') ||
    lower.includes('otp_expired')
  ) {
    return 'El enlace de recuperación ha caducado o ya fue utilizado. Por seguridad, cada enlace solo puede usarse una vez. Solicita un nuevo correo de recuperación.';
  }
  if (
    code === 'access_denied' ||
    lower.includes('access_denied') ||
    lower.includes('flow_state_not_found') ||
    lower.includes('flow state') ||
    lower.includes('code verifier') ||
    lower.includes('both auth code and code verifier')
  ) {
    return 'No se pudo validar el enlace de recuperación (puede haber expirado o haberse abierto en un navegador distinto). Solicita un nuevo enlace de recuperación.';
  }
  if (lower.includes('same_password') || lower.includes('different from the old password')) {
    return 'La nueva contraseña debe ser diferente de tu contraseña actual.';
  }
  if (lower.includes('at least') || lower.includes('weak_password') || lower.includes('password should be')) {
    return 'La nueva contraseña es demasiado corta o débil (mínimo 6 caracteres).';
  }
  if (lower.includes('rate limit') || lower.includes('over_email_send_rate_limit') || lower.includes('for security purposes')) {
    return 'Has solicitado demasiados correos recientemente. Espera unos segundos antes de volver a intentarlo.';
  }
  if (lower.includes('auth session missing') || lower.includes('session_not_found')) {
    return 'Tu sesión de recuperación ha caducado. Por favor, solicita un nuevo enlace de recuperación.';
  }
  return msg || 'El enlace de recuperación no es válido o ha caducado. Solicita uno nuevo.';
}

function getRecoveryAmrIdentifier(session: Session | null): string | null {
  if (!session?.access_token) return null;
  const parts = session.access_token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64));
    if (Array.isArray(payload?.amr) && payload.amr.length > 0) {
      const latest = payload.amr[0];
      if (latest === 'recovery') {
        return `${session.user?.id || 'u'}:${payload.iat || 'recovery'}`;
      }
      if (latest && typeof latest === 'object' && latest.method === 'recovery') {
        return `${session.user?.id || 'u'}:${latest.timestamp || payload.iat || 'recovery'}`;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function isSessionFromUncompletedRecovery(session: Session | null): boolean {
  const amrId = getRecoveryAmrIdentifier(session);
  if (!amrId) return false;
  try {
    const completedId = window.sessionStorage.getItem(RECOVERY_COMPLETED_TS_KEY);
    if (completedId && completedId === amrId) {
      return false;
    }
  } catch {
    // ignore storage errors
  }
  return true;
}

function cleanAuthCallbackUrlInBrowser(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    const paramsToClean = [
      'code',
      'token_hash',
      'token',
      'type',
      'error',
      'error_code',
      'error_description',
      'recovery'
    ];
    let mutated = false;
    for (const key of paramsToClean) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        mutated = true;
      }
    }
    if (
      url.hash &&
      (url.hash.includes('access_token=') ||
        url.hash.includes('type=recovery') ||
        url.hash.includes('error=') ||
        url.hash.includes('error_code='))
    ) {
      url.hash = '';
      mutated = true;
    }
    if (mutated) {
      const cleanPath =
        url.pathname + (url.search ? url.search : '') + (url.hash ? url.hash : '');
      window.history.replaceState(window.history.state, document.title, cleanPath || '/');
    }
  } catch {
    // ignore URL cleanup errors
  }
}

let currentRecoveryState: PasswordRecoveryState = {
  isRecovery: Boolean(
    initialUrlSnapshot.isRecoveryIntent &&
      !initialUrlSnapshot.error &&
      !initialUrlSnapshot.errorCode
  ),
  error:
    initialUrlSnapshot.error || initialUrlSnapshot.errorCode || initialUrlSnapshot.errorDescription
      ? translateSupabaseRecoveryError(
          initialUrlSnapshot.errorDescription || initialUrlSnapshot.error,
          initialUrlSnapshot.errorCode
        )
      : null
};

type RecoveryStateListener = (state: PasswordRecoveryState) => void;
const recoveryListeners = new Set<RecoveryStateListener>();

function updateRecoveryState(next: Partial<PasswordRecoveryState>): void {
  currentRecoveryState = {
    ...currentRecoveryState,
    ...next
  };
  for (const listener of recoveryListeners) {
    try {
      listener(currentRecoveryState);
    } catch {
      // ignore listener errors
    }
  }
}

export function getPasswordRecoveryState(): PasswordRecoveryState {
  return currentRecoveryState;
}

export function subscribePasswordRecoveryState(listener: RecoveryStateListener): () => void {
  recoveryListeners.add(listener);
  listener(currentRecoveryState);
  return () => {
    recoveryListeners.delete(listener);
  };
}

export function clearPasswordRecoveryState(session?: Session | null): void {
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(RECOVERY_PENDING_STORAGE_KEY);
      const amrId = getRecoveryAmrIdentifier(session || null);
      if (amrId) {
        window.sessionStorage.setItem(RECOVERY_COMPLETED_TS_KEY, amrId);
      }
    } catch {
      // ignore storage errors
    }
  }
  initialUrlSnapshot.isRecoveryIntent = false;
  initialUrlSnapshot.tokenHash = null;
  initialUrlSnapshot.error = null;
  initialUrlSnapshot.errorCode = null;
  initialUrlSnapshot.errorDescription = null;
  CleanUrlAndResetState();
}

function CleanUrlAndResetState(): void {
  cleanAuthCallbackUrlInBrowser();
  updateRecoveryState({ isRecovery: false, error: null });
}

function createBrowserSupabaseClient(url: string, anonKey: string): SupabaseClient {
  const client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: typeof window !== 'undefined' ? window.localStorage : undefined
    },
    realtime: {
      params: {
        eventsPerSecond: 10
      }
    }
  });

  // Register an immediate listener right on client creation so PASSWORD_RECOVERY emitted on setTimeout(0)
  // during client._initialize() is NEVER missed before React effects mount.
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      try {
        window.sessionStorage.setItem(RECOVERY_PENDING_STORAGE_KEY, 'true');
      } catch {
        // ignore
      }
      cleanAuthCallbackUrlInBrowser();
      updateRecoveryState({ isRecovery: true, error: null });
      return;
    }

    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
      let pendingInStorage = false;
      try {
        pendingInStorage = window.sessionStorage.getItem(RECOVERY_PENDING_STORAGE_KEY) === 'true';
      } catch {
        // ignore
      }
      if (
        session &&
        (initialUrlSnapshot.isRecoveryIntent ||
          pendingInStorage ||
          isSessionFromUncompletedRecovery(session))
      ) {
        try {
          window.sessionStorage.setItem(RECOVERY_PENDING_STORAGE_KEY, 'true');
        } catch {
          // ignore
        }
        cleanAuthCallbackUrlInBrowser();
        updateRecoveryState({ isRecovery: true, error: null });
      }
    } else if (event === 'SIGNED_OUT') {
      try {
        window.sessionStorage.removeItem(RECOVERY_PENDING_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  });

  return client;
}

let urlRecoveryResolutionPromise: Promise<PasswordRecoveryState> | null = null;

/**
 * Inspects the initial browser URL and active Supabase session to handle:
 * 1. Explicit error parameters in URL (#error=access_denied&error_code=otp_expired...)
 * 2. Token-hash recovery links (?token_hash=...&type=recovery) via verifyOtp
 * 3. Implicit (#access_token=...&type=recovery) and PKCE (?code=...) recovery sessions
 * 4. Expired or invalid recovery links that failed to establish a session
 */
export async function resolvePasswordRecoveryFromUrl(
  clientInstance?: SupabaseClient | null
): Promise<PasswordRecoveryState> {
  if (typeof window === 'undefined') {
    return currentRecoveryState;
  }

  if (urlRecoveryResolutionPromise) {
    return urlRecoveryResolutionPromise;
  }

  urlRecoveryResolutionPromise = (async () => {
    const client = clientInstance || (await ensureSupabaseClient());

    // 1. If the URL explicitly carried an error from Supabase Auth redirect
    if (
      initialUrlSnapshot.error ||
      initialUrlSnapshot.errorCode ||
      initialUrlSnapshot.errorDescription
    ) {
      const translated = translateSupabaseRecoveryError(
        initialUrlSnapshot.errorDescription || initialUrlSnapshot.error,
        initialUrlSnapshot.errorCode
      );
      try {
        window.sessionStorage.removeItem(RECOVERY_PENDING_STORAGE_KEY);
      } catch {
        // ignore
      }
      cleanAuthCallbackUrlInBrowser();
      updateRecoveryState({ isRecovery: false, error: translated });
      return currentRecoveryState;
    }

    if (!client) {
      return currentRecoveryState;
    }

    // 2. If the recovery link uses ?token_hash=...&type=recovery (custom or PKCE token_hash template)
    if (initialUrlSnapshot.tokenHash && initialUrlSnapshot.isRecoveryIntent) {
      const tokenHashToVerify = initialUrlSnapshot.tokenHash;
      initialUrlSnapshot.tokenHash = null;
      try {
        const { data, error } = await client.auth.verifyOtp({
          token_hash: tokenHashToVerify,
          type: 'recovery'
        });
        cleanAuthCallbackUrlInBrowser();
        if (error || !data?.session) {
          try {
            window.sessionStorage.removeItem(RECOVERY_PENDING_STORAGE_KEY);
          } catch {
            // ignore
          }
          updateRecoveryState({
            isRecovery: false,
            error: translateSupabaseRecoveryError(error?.message, (error as any)?.code)
          });
          return currentRecoveryState;
        }
        try {
          window.sessionStorage.setItem(RECOVERY_PENDING_STORAGE_KEY, 'true');
        } catch {
          // ignore
        }
        updateRecoveryState({ isRecovery: true, error: null });
        return currentRecoveryState;
      } catch (err: any) {
        cleanAuthCallbackUrlInBrowser();
        updateRecoveryState({
          isRecovery: false,
          error: translateSupabaseRecoveryError(err?.message)
        });
        return currentRecoveryState;
      }
    }

    // 3. Check current session after Supabase client initialization
    try {
      const { data: { session }, error: sessionError } = await client.auth.getSession();

      let pendingInStorage = false;
      try {
        pendingInStorage = window.sessionStorage.getItem(RECOVERY_PENDING_STORAGE_KEY) === 'true';
      } catch {
        // ignore
      }

      if (session) {
        if (
          currentRecoveryState.isRecovery ||
          initialUrlSnapshot.isRecoveryIntent ||
          pendingInStorage ||
          isSessionFromUncompletedRecovery(session)
        ) {
          try {
            window.sessionStorage.setItem(RECOVERY_PENDING_STORAGE_KEY, 'true');
          } catch {
            // ignore
          }
          cleanAuthCallbackUrlInBrowser();
          updateRecoveryState({ isRecovery: true, error: null });
          return currentRecoveryState;
        }
      } else if (initialUrlSnapshot.isRecoveryIntent || pendingInStorage) {
        // The user arrived via a recovery URL (type=recovery) but no valid session could be established
        try {
          window.sessionStorage.removeItem(RECOVERY_PENDING_STORAGE_KEY);
        } catch {
          // ignore
        }
        cleanAuthCallbackUrlInBrowser();
        updateRecoveryState({
          isRecovery: false,
          error: translateSupabaseRecoveryError(
            sessionError?.message ||
              'El enlace de recuperación ha caducado o ya fue utilizado. Solicita un nuevo correo de recuperación.',
            (sessionError as any)?.code
          )
        });
        return currentRecoveryState;
      }
    } catch {
      // ignore
    }

    return currentRecoveryState;
  })();

  try {
    return await urlRecoveryResolutionPromise;
  } finally {
    urlRecoveryResolutionPromise = null;
  }
}

const initialConfig = resolveInitialPublicConfig();
let currentMissingVars: string[] = initialConfig.missingVars;

export let isSupabaseConfigured: boolean = Boolean(initialConfig.url && initialConfig.anonKey);

export let supabase: SupabaseClient | null = isSupabaseConfigured
  ? createBrowserSupabaseClient(initialConfig.url, initialConfig.anonKey)
  : null;

let configFetchPromise: Promise<SupabaseClient | null> | null = null;

export function getSupabaseConfigErrorMessage(): string {
  if (currentMissingVars.length > 0) {
    return `Configuración de Supabase incompleta: falta ${currentMissingVars.join(' y ')} en el entorno de ejecución.`;
  }
  return 'Supabase no está configurado en las variables de entorno (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).';
}

export async function ensureSupabaseClient(): Promise<SupabaseClient | null> {
  if (supabase && isSupabaseConfigured) {
    return supabase;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  if (!configFetchPromise) {
    configFetchPromise = (async () => {
      try {
        const res = await fetch('/api/supabase/config', { cache: 'no-store' });
        if (!res.ok) return null;
        const data = (await res.json()) as RuntimePublicSupabaseConfig;
        const url = (data?.url || '').trim();
        const anonKey = (data?.anonKey || '').trim();
        if (Array.isArray(data?.missingVars)) {
          currentMissingVars = data.missingVars;
        }
        if (
          url &&
          url.startsWith('https://') &&
          !url.includes('YOUR_SUPABASE') &&
          isValidClientAnonKey(anonKey)
        ) {
          window.__VECINOYA_SUPABASE_CONFIG__ = { configured: true, url, anonKey, missingVars: [] };
          currentMissingVars = [];
          supabase = createBrowserSupabaseClient(url, anonKey);
          isSupabaseConfigured = true;
          return supabase;
        }
      } catch {
        // ignore network errors and fall back to existing state
      } finally {
        configFetchPromise = null;
      }
      return supabase;
    })();
  }
  return configFetchPromise;
}

/**
 * Maps a Supabase Auth user (auth.users) to the application User model
 */
export function mapSupabaseUserToUser(authUser: SupabaseAuthUser): User {
  const metadata = authUser.user_metadata || {};
  const appMetadata = authUser.app_metadata || {};
  const email = authUser.email || '';
  const fallbackName = email.split('@')[0] || 'Vecino';

  return {
    id: authUser.id,
    name: metadata.name || metadata.full_name || fallbackName,
    email: email,
    avatar:
      (metadata.avatar_url || metadata.avatar || '').includes('photo-1535713875002-d1d0cf377fde')
        ? ''
        : (metadata.avatar_url || metadata.avatar || ''),
    neighborhood: metadata.neighborhood || '',
    city: metadata.city || 'Madrid',
    bio: metadata.bio || '',
    phone: metadata.phone || '',
    // Never grant admin role from user_metadata (editable by the user via supabase.auth.updateUser).
    // Only recognize app_metadata.role on the client (note: client state never replaces server/RLS enforcement).
    role: appMetadata.role === 'admin' ? 'admin' : 'user',
    joinedDate: new Date(authUser.created_at).toLocaleDateString('es-ES', {
      month: 'long',
      year: 'numeric'
    }),
    isDemo: false,
    authProvider: 'supabase',
    emailConfirmed: Boolean(authUser.email_confirmed_at)
  };
}

/**
 * Supabase Auth API Operations
 */
export async function authSignUp(
  email: string,
  password: string,
  profile: { name: string; neighborhood: string; city?: string; phone?: string }
): Promise<{ user: User | null; session: Session | null; error: string | null }> {
  const client = await ensureSupabaseClient();
  if (!client) {
    return { user: null, session: null, error: getSupabaseConfigErrorMessage() };
  }

  try {
    const { data, error } = await client.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          name: profile.name.trim(),
          neighborhood: profile.neighborhood.trim(),
          city: (profile.city || 'Madrid').trim(),
          phone: (profile.phone || '').trim()
        }
      }
    });

    if (error) {
      return { user: null, session: null, error: error.message };
    }

    const appUser = data.user ? mapSupabaseUserToUser(data.user) : null;
    return { user: appUser, session: data.session, error: null };
  } catch (err: any) {
    return { user: null, session: null, error: err.message || 'Error inesperado durante el registro.' };
  }
}

export async function authSignIn(
  email: string,
  password: string
): Promise<{ user: User | null; session: Session | null; error: string | null }> {
  const client = await ensureSupabaseClient();
  if (!client) {
    return { user: null, session: null, error: getSupabaseConfigErrorMessage() };
  }

  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: email.trim(),
      password
    });

    if (error) {
      return { user: null, session: null, error: error.message };
    }

    const appUser = data.user ? mapSupabaseUserToUser(data.user) : null;
    return { user: appUser, session: data.session, error: null };
  } catch (err: any) {
    return { user: null, session: null, error: err.message || 'Error inesperado al iniciar sesión.' };
  }
}

export async function authSignOut(): Promise<{ error: string | null }> {
  const client = await ensureSupabaseClient();
  if (!client) return { error: null };
  try {
    clearPasswordRecoveryState(null);
    const { error } = await client.auth.signOut();
    return { error: error ? error.message : null };
  } catch (err: any) {
    return { error: err.message || 'Error al cerrar sesión.' };
  }
}

export async function authResetPassword(email: string): Promise<{ error: string | null }> {
  const client = await ensureSupabaseClient();
  if (!client) {
    return { error: getSupabaseConfigErrorMessage() };
  }
  try {
    const redirectTo =
      typeof window !== 'undefined' ? `${window.location.origin}/` : undefined;
    const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
      redirectTo
    });
    return {
      error: error ? translateSupabaseRecoveryError(error.message, (error as any)?.code) : null
    };
  } catch (err: any) {
    return {
      error: translateSupabaseRecoveryError(
        err?.message || 'Error al solicitar recuperación de contraseña.'
      )
    };
  }
}

export async function authUpdatePassword(
  newPassword: string
): Promise<{ user: User | null; error: string | null }> {
  const client = await ensureSupabaseClient();
  if (!client) {
    return { user: null, error: getSupabaseConfigErrorMessage() };
  }

  try {
    const {
      data: { session: currentSession }
    } = await client.auth.getSession();

    if (!currentSession) {
      return {
        user: null,
        error:
          'Tu sesión de recuperación ha caducado o no es válida. Por favor, solicita un nuevo enlace de recuperación.'
      };
    }

    const { data, error } = await client.auth.updateUser({
      password: newPassword
    });

    if (error) {
      return {
        user: null,
        error: translateSupabaseRecoveryError(error.message, (error as any)?.code)
      };
    }

    clearPasswordRecoveryState(currentSession);
    const appUser = data.user ? mapSupabaseUserToUser(data.user) : null;
    return { user: appUser, error: null };
  } catch (err: any) {
    return {
      user: null,
      error: translateSupabaseRecoveryError(
        err?.message || 'Error inesperado al actualizar la contraseña.'
      )
    };
  }
}

export async function authUpdateProfile(
  updates: UserProfileUpdate
): Promise<{ user: User | null; error: string | null }> {
  const client = await ensureSupabaseClient();
  if (!client) {
    return { user: null, error: getSupabaseConfigErrorMessage() };
  }

  try {
    const { data, error } = await client.auth.updateUser({
      data: {
        ...(updates.name ? { name: updates.name.trim() } : {}),
        ...(updates.phone !== undefined ? { phone: updates.phone.trim() } : {}),
        ...(updates.neighborhood ? { neighborhood: updates.neighborhood.trim() } : {}),
        ...(updates.city ? { city: updates.city.trim() } : {}),
        ...(updates.bio ? { bio: updates.bio.trim() } : {}),
        ...(updates.avatar ? { avatar: updates.avatar.trim() } : {})
      }
    });

    if (error) {
      return { user: null, error: error.message };
    }

    const appUser = data.user ? mapSupabaseUserToUser(data.user) : null;
    return { user: appUser, error: null };
  } catch (err: any) {
    return { user: null, error: err.message || 'Error al actualizar el perfil.' };
  }
}

export async function authGetSession(): Promise<Session | null> {
  const client = await ensureSupabaseClient();
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    return data.session;
  } catch {
    return null;
  }
}

export const getCurrentSession = authGetSession;

export async function authGetUser(): Promise<User | null> {
  const client = await ensureSupabaseClient();
  if (!client) return null;
  try {
    const { data } = await client.auth.getUser();
    return data.user ? mapSupabaseUserToUser(data.user) : null;
  } catch {
    return null;
  }
}

export const getCurrentAuthUser = authGetUser;

const VALID_PRICE_TYPES: ReadonlyArray<ServiceListing['priceType']> = [
  'hora',
  'trabajo',
  'a_convenir'
];

const VALID_CONTACT_METHODS: ReadonlyArray<ServiceListing['contactMethod']> = [
  'whatsapp',
  'phone',
  'chat',
  'email'
];

// Database row interface matching the exact 26 PostgreSQL snake_case columns in public.services
export interface ServiceRow {
  id: string;
  title: string;
  category_id: string;
  description: string;
  price: number;
  price_type: 'hora' | 'trabajo' | 'a_convenir';
  neighborhood: string;
  city: string;
  availability: string;
  image_url: string;
  contact_method: 'whatsapp' | 'phone' | 'chat' | 'email';
  contact_value: string;
  additional_notes?: string | null;
  author_id: string;
  author_name: string;
  author_avatar: string;
  author_rating: number;
  author_review_count: number;
  status: 'active' | 'suspended' | 'draft';
  is_featured: boolean;
  featured_plan_id?: string | null;
  featured_plan_name?: string | null;
  featured_until?: string | null;
  report_count: number;
  created_at: string;
  updated_at?: string;
}

// Strict client-side INSERT whitelist (17 columns; never sends system/reputation/promotion/timestamp fields)
export interface ClientServiceInsertRow {
  id: string;
  title: string;
  category_id: string;
  description: string;
  price: number;
  price_type: 'hora' | 'trabajo' | 'a_convenir';
  neighborhood: string;
  city: string;
  availability: string;
  image_url: string;
  contact_method: 'whatsapp' | 'phone' | 'chat' | 'email';
  contact_value: string;
  additional_notes: string | null;
  author_id: string;
  author_name: string;
  author_avatar: string;
  status: 'active' | 'draft';
}

// Strict client-side UPDATE whitelist (15 columns; excludes id, author_id and all system/promotion/reputation fields)
export interface ClientServiceUpdateRow {
  title: string;
  category_id: string;
  description: string;
  price: number;
  price_type: 'hora' | 'trabajo' | 'a_convenir';
  neighborhood: string;
  city: string;
  availability: string;
  image_url: string;
  contact_method: 'whatsapp' | 'phone' | 'chat' | 'email';
  contact_value: string;
  additional_notes: string | null;
  author_name: string;
  author_avatar: string;
  status: 'active' | 'draft';
}

// Convert Database Row (snake_case) -> Application Type (camelCase)
export function mapRowToService(row: ServiceRow): ServiceListing {
  const numericPrice = Number(row.price ?? 0);
  const safePrice = Number.isFinite(numericPrice) && numericPrice >= 0 ? numericPrice : 0;
  const resolvedPriceType: ServiceListing['priceType'] =
    row.price_type && VALID_PRICE_TYPES.includes(row.price_type)
      ? row.price_type
      : safePrice === 0
        ? 'a_convenir'
        : 'hora';
  const resolvedContactMethod: ServiceListing['contactMethod'] =
    row.contact_method && VALID_CONTACT_METHODS.includes(row.contact_method)
      ? row.contact_method
      : 'whatsapp';
  const resolvedReviewCount =
    typeof row.author_review_count === 'number' &&
    !Number.isNaN(Number(row.author_review_count)) &&
    Number(row.author_review_count) > 0
      ? Number(row.author_review_count)
      : 0;
  const resolvedRating =
    resolvedReviewCount > 0 &&
    typeof row.author_rating === 'number' &&
    !Number.isNaN(Number(row.author_rating)) &&
    Number(row.author_rating) > 0
      ? Number(row.author_rating)
      : 0;
  const resolvedStatus: 'active' | 'suspended' | 'draft' =
    row.status === 'draft'
      ? 'draft'
      : row.status === 'suspended'
        ? 'suspended'
        : 'active';
  const rawAvatar = row.author_avatar || '';
  const cleanAvatar = rawAvatar.includes('photo-1535713875002-d1d0cf377fde') ? '' : rawAvatar;

  return {
    id: row.id,
    title: row.title,
    categoryId: row.category_id,
    description: row.description,
    price: safePrice,
    priceType: resolvedPriceType,
    neighborhood: row.neighborhood || 'Centro',
    city: row.city || 'Madrid',
    availability: row.availability || 'Lunes a Viernes (tardes) y fines de semana',
    imageUrl: row.image_url,
    contactMethod: resolvedContactMethod,
    contactValue: row.contact_value || '',
    additionalNotes: row.additional_notes || undefined,
    authorId: row.author_id,
    authorName: row.author_name || 'Vecino',
    authorAvatar: cleanAvatar,
    authorRating: resolvedRating,
    authorReviewCount: resolvedReviewCount,
    createdAt: row.created_at || new Date().toISOString(),
    status: resolvedStatus,
    ownerSessionActive: true,
    isFeatured: Boolean(row.is_featured),
    featuredPlanId: row.featured_plan_id || undefined,
    featuredPlanName: row.featured_plan_name || undefined,
    featuredUntil: row.featured_until || undefined,
    reportCount: Number(row.report_count ?? 0)
  };
}

/**
 * Builds the strict 17-column payload allowed for client INSERT into `public.services`.
 * Never includes reputation, promotion, report_count, or server-managed timestamps.
 * Rejects `status === 'suspended'` or missing `verifiedAuthorId`.
 */
export function buildClientInsertRow(
  service: ServiceListing,
  verifiedAuthorId: string
): ClientServiceInsertRow {
  const trimmedAuthorId = (verifiedAuthorId || '').trim();
  if (!trimmedAuthorId) {
    throw new Error(
      'Se requiere un author_id autenticado válido para construir el payload de inserción.'
    );
  }
  if (service.status === 'suspended') {
    throw new Error(
      'Operación no permitida: el cliente no puede insertar un anuncio con estado suspended.'
    );
  }

  const numericPrice = Number(service.price ?? 0);
  const safePrice = Number.isFinite(numericPrice) && numericPrice >= 0 ? numericPrice : 0;
  const resolvedPriceType: ClientServiceInsertRow['price_type'] =
    VALID_PRICE_TYPES.includes(service.priceType)
      ? service.priceType
      : safePrice === 0
        ? 'a_convenir'
        : 'hora';
  const resolvedContactMethod: ClientServiceInsertRow['contact_method'] =
    VALID_CONTACT_METHODS.includes(service.contactMethod)
      ? service.contactMethod
      : 'whatsapp';
  const editorialStatus: 'active' | 'draft' =
    service.status === 'draft' ? 'draft' : 'active';

  return {
    id: service.id.trim(),
    title: service.title.trim(),
    category_id: service.categoryId || 'hogar',
    description: service.description.trim(),
    price: resolvedPriceType === 'a_convenir' ? 0 : safePrice,
    price_type: resolvedPriceType,
    neighborhood: (service.neighborhood || 'Centro').trim() || 'Centro',
    city: (service.city || 'Madrid').trim() || 'Madrid',
    availability:
      (service.availability || 'Lunes a Viernes (tardes) y fines de semana').trim() ||
      'Lunes a Viernes (tardes) y fines de semana',
    image_url:
      service.imageUrl || '/src/assets/images/service_home_repairs_1791572265993.jpg',
    contact_method: resolvedContactMethod,
    contact_value: (service.contactValue || '').trim(),
    additional_notes: service.additionalNotes ? service.additionalNotes.trim() : null,
    author_id: trimmedAuthorId,
    author_name: (service.authorName || 'Vecino').trim() || 'Vecino',
    author_avatar: (service.authorAvatar || '').trim(),
    status: editorialStatus
  };
}

/**
 * Builds the strict 15-column payload allowed for client UPDATE on `public.services`.
 * Never includes `id`, `author_id`, reputation, promotion, report_count, or timestamps.
 * Rejects `status === 'suspended'` so suspended services cannot be edited or reactivated from client.
 */
export function buildClientUpdateRow(service: ServiceListing): ClientServiceUpdateRow {
  if (service.status === 'suspended') {
    throw new Error(
      'Operación no permitida: el cliente no puede actualizar ni reactivar un anuncio con estado suspended.'
    );
  }

  const numericPrice = Number(service.price ?? 0);
  const safePrice = Number.isFinite(numericPrice) && numericPrice >= 0 ? numericPrice : 0;
  const resolvedPriceType: ClientServiceUpdateRow['price_type'] =
    VALID_PRICE_TYPES.includes(service.priceType)
      ? service.priceType
      : safePrice === 0
        ? 'a_convenir'
        : 'hora';
  const resolvedContactMethod: ClientServiceUpdateRow['contact_method'] =
    VALID_CONTACT_METHODS.includes(service.contactMethod)
      ? service.contactMethod
      : 'whatsapp';
  const editorialStatus: 'active' | 'draft' =
    service.status === 'draft' ? 'draft' : 'active';

  return {
    title: service.title.trim(),
    category_id: service.categoryId || 'hogar',
    description: service.description.trim(),
    price: resolvedPriceType === 'a_convenir' ? 0 : safePrice,
    price_type: resolvedPriceType,
    neighborhood: (service.neighborhood || 'Centro').trim() || 'Centro',
    city: (service.city || 'Madrid').trim() || 'Madrid',
    availability:
      (service.availability || 'Lunes a Viernes (tardes) y fines de semana').trim() ||
      'Lunes a Viernes (tardes) y fines de semana',
    image_url:
      service.imageUrl || '/src/assets/images/service_home_repairs_1791572265993.jpg',
    contact_method: resolvedContactMethod,
    contact_value: (service.contactValue || '').trim(),
    additional_notes: service.additionalNotes ? service.additionalNotes.trim() : null,
    author_name: (service.authorName || 'Vecino').trim() || 'Vecino',
    author_avatar: (service.authorAvatar || '').trim(),
    status: editorialStatus
  };
}
