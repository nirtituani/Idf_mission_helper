// WhatsApp Cloud API (Graph) client. Never logs; never throws from public methods.
const GRAPH = 'https://graph.facebook.com/v25.0';
const TIMEOUT_MS = 15000;
const CACHE_MS = 5 * 60 * 1000;
const RETRY_CODES = new Set([130429, 131048, 80007]);

export function describeError(code) {
  const n = Number(code);
  if (n === 131026) return 'המספר אינו זמין ב־WhatsApp';
  if (n === 130429 || n === 131048) return 'חריגה ממגבלת שליחה של Meta';
  if (n >= 132000 && n <= 132015) return 'בעיה בתבנית ההודעה';
  if (n === 190) return 'אסימון הגישה של Meta אינו תקף';
  return `שגיאת Meta (קוד ${code})`;
}

export function createWhatsAppClient({
  token, phoneNumberId, wabaId, templateName, templateLang,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const headers = { Authorization: `Bearer ${token}` };

  async function attempt(params, to) {
    let res;
    try {
      res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', to, type: 'template',
          template: {
            name: templateName, language: { code: templateLang },
            components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, retry: true, error: 'שגיאת רשת בשליחה ל־Meta' };
    }
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }
    const wamid = body?.messages?.[0]?.id;
    if (res.ok && wamid) return { ok: true, wamid };
    const code = body?.error?.code;
    if (code !== undefined) {
      return { ok: false, retry: RETRY_CODES.has(Number(code)) || res.status >= 500, error: describeError(code) };
    }
    return { ok: false, retry: res.status >= 500, error: `שגיאת Meta (HTTP ${res.status})` };
  }

  async function sendTemplate(to, params) {
    try {
      let r = await attempt(params, to);
      if (!r.ok && r.retry) {
        await sleep(2000);
        r = await attempt(params, to);
      }
      return r.ok ? { ok: true, wamid: r.wamid } : { ok: false, error: r.error };
    } catch {
      return { ok: false, error: 'שגיאה בשליחה' };
    }
  }

  let cache = null; // { status, at }
  async function templateStatus() {
    if (cache && now() - cache.at < CACHE_MS) return cache.status;
    try {
      const url = `${GRAPH}/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}&fields=name,status,language`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return 'ERROR';
      const body = await res.json();
      const entry = (body?.data || []).find((t) => t.language === templateLang);
      const status = entry?.status && typeof entry.status === 'string' ? entry.status : 'MISSING';
      cache = { status, at: now() };
      return status;
    } catch {
      return 'ERROR';
    }
  }

  return { sendTemplate, templateStatus, describeError };
}
