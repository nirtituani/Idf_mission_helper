// One-time Meta setup: subscribes the app to the WABA's webhooks and prints template / phone status.
// Run locally: WA_TOKEN=… WA_WABA_ID=… WA_PHONE_NUMBER_ID=… npm run wa:setup
// Never prints the token.
const GRAPH = 'https://graph.facebook.com/v25.0';
const WEBHOOK_URL = 'https://idf-mission-helper.onrender.com/webhooks/whatsapp';

const env = process.env;
const missing = ['WA_TOKEN', 'WA_WABA_ID', 'WA_PHONE_NUMBER_ID'].filter((n) => !env[n]?.trim());
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
const token = env.WA_TOKEN.trim();
const waba = env.WA_WABA_ID.trim();
const phoneId = env.WA_PHONE_NUMBER_ID.trim();
const templatePrefix = env.WA_TEMPLATE_PREFIX?.trim() || 'duty_roster_days_';
const templateLang = env.WA_TEMPLATE_LANG?.trim() || 'he';

async function graph(path, method = 'GET') {
  try {
    const res = await fetch(`${GRAPH}/${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body?.error?.message || `HTTP ${res.status}` };
    return body;
  } catch (e) {
    return { error: e.message };
  }
}

const sub = await graph(`${waba}/subscribed_apps`, 'POST');
console.log(`subscribed: ${sub.success ? 'yes' : `no (${sub.error || 'no success in response'})`}`);

const tpl = await graph(`${waba}/message_templates?fields=name,language,status&limit=200`);
if (tpl.error) console.log(`template: error (${tpl.error})`);
else {
  // one template per number of duty days (1–8)
  for (let k = 1; k <= 8; k++) {
    const name = `${templatePrefix}${k}`;
    const t = (tpl.data || []).find((x) => x.name === name && x.language === templateLang);
    console.log(`template ${name} (${templateLang}): ${t ? t.status : 'not found'}`);
  }
}

const ph = await graph(`${phoneId}?fields=display_phone_number,verified_name,quality_rating,status`);
if (ph.error) console.log(`phone: error (${ph.error})`);
else console.log(`phone: ${ph.display_phone_number} status=${ph.status} quality=${ph.quality_rating} name=${ph.verified_name}`);

console.log(`webhook URL: ${WEBHOOK_URL}`);
