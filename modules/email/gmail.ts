/**
 * Gmail, read-only: Google's sign-in (OAuth 2.0 for a web app, with the
 * household's own Google Cloud client), keeping the sign-in fresh, and finding
 * and reading the emails the household's rules point to. Everything goes
 * through the `fetch` it's given, so tests stand in for Google.
 */
import { LarderError } from '@larder/core';

export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** Where Google sends the person back: the Larder integration's page in Home Assistant, which passes it on. */
export const CALLBACK_PATH = '/api/larder/gmail/callback';

export interface Client { clientId: string; clientSecret: string; redirectUri: string }
/** expiresIn is in seconds. */
export interface Tokens { accessToken: string; refreshToken: string | null; expiresIn: number; scope: string }

/** A problem only the person can fix (sign in again, check the client): kept and shown until they do. */
export class GmailSignedOut extends LarderError {
  constructor(message: string) {
    super(message, 409, 'gmail_signed_out');
  }
}

export function authorizeUrl(c: Client, state: string): string {
  const q = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: SCOPE,
    // A refresh token, so Larder can keep checking without the person.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH}?${q}`;
}

export function gmail(doFetch: typeof fetch) {
  async function token(form: Record<string, string>): Promise<Tokens> {
    let res: Response;
    try {
      res = await doFetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new LarderError("Couldn't reach Google. Check Larder's internet connection and try again.", 502, 'gmail_unreachable');
    }
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      const said = data.error_description ?? data.error ?? `HTTP ${res.status}`;
      if (data.error === 'invalid_grant') {
        throw new GmailSignedOut(form.grant_type === 'refresh_token'
          ? `Google signed Larder out of Gmail (${said}). Connect Gmail again. If this happens every week, publish the app in Google Cloud (step 6).`
          : `Google didn't accept the sign-in (${said}). Connect Gmail again.`);
      }
      if (data.error === 'invalid_client' || data.error === 'unauthorized_client') throw new GmailSignedOut(`Google didn't accept the client ID or secret (${said}). Check them in step 8.`);
      if (data.error === 'redirect_uri_mismatch') throw new GmailSignedOut(`Google says the return address doesn't match the one in Google Cloud (${said}). Check step 7, and your Home Assistant address in step 1.`);
      throw new LarderError(`Google sign-in failed: ${said}`, 502, 'gmail_failed');
    }
    return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresIn: data.expires_in ?? 3600, scope: data.scope ?? '' };
  }

  async function get<T>(accessToken: string, path: string): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${API}${path}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new LarderError("Couldn't reach Gmail. Check Larder's internet connection and try again.", 502, 'gmail_unreachable');
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (res.status === 401) throw new GmailSignedOut('Gmail turned Larder away. Connect Gmail again.');
    if (res.status === 403) throw new GmailSignedOut(`Gmail refused: ${data.error?.message ?? 'no access'}. Check the Gmail API is on (step 3), then connect Gmail again.`);
    if (!res.ok) throw new LarderError(`Gmail answered: ${data.error?.message ?? `HTTP ${res.status}`}`, 502, 'gmail_failed');
    return data;
  }

  return {
    signIn: (c: Client, code: string) => token({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: 'authorization_code' }),
    refresh: (c: Client, refreshToken: string) => token({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token' }),
    async revoke(t: string): Promise<void> {
      await doFetch(REVOKE, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t }).toString(), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
    },
    profile: (accessToken: string) => get<{ emailAddress: string }>(accessToken, '/profile'),
    /** Ids of the emails matching a Gmail search, newest first. */
    async search(accessToken: string, q: string, max = 25): Promise<string[]> {
      const r = await get<{ messages?: Array<{ id: string }> }>(accessToken, `/messages?${new URLSearchParams({ q, maxResults: String(max) })}`);
      return (r.messages ?? []).map((m) => m.id);
    },
    async message(accessToken: string, id: string): Promise<Message> {
      return toMessage(await get<RawMessage>(accessToken, `/messages/${encodeURIComponent(id)}?format=full`));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

interface Part { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Array<{ name: string; value: string }> }
export interface RawMessage { id: string; internalDate?: string; payload?: Part }
export interface Message { id: string; subject: string; from: string; sentAt: string; text: string }

/** Gmail's base64url, as UTF-8 text. */
export function decode(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

/** An HTML email as readable text: rows and paragraphs on their own lines, table cells apart. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, (s) => (s.includes('\t') ? '\t' : ' '))
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function toMessage(raw: RawMessage): Message {
  const headers = raw.payload?.headers ?? [];
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? '';
  let plain = '';
  let html = '';
  const walk = (p: Part | undefined) => {
    if (!p) return;
    const type = (p.mimeType ?? '').toLowerCase();
    if (p.body?.data && type === 'text/plain' && !plain) plain = decode(p.body.data);
    else if (p.body?.data && type === 'text/html' && !html) html = decode(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(raw.payload);
  const sent = Number(raw.internalDate);
  // Shops' plain text is often a stub ("view this email in your browser"): the HTML is the email then.
  const fromHtml = html ? htmlToText(html) : '';
  const text = plain.trim().length >= 200 || !fromHtml ? plain.trim() : fromHtml;
  return { id: raw.id, subject: header('subject'), from: header('from'), sentAt: new Date(Number.isFinite(sent) && sent > 0 ? sent : Date.now()).toISOString(), text };
}
