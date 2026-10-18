// WhatsApp sending configuration from env vars. Any missing/invalid required var → sending disabled
// (the rest of the site works as before). Only var NAMES are ever reported, never values.
import { normalizePhone } from '../src/core/phones.js';

const REQUIRED = ['WA_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_WABA_ID', 'WA_APP_SECRET', 'WA_VERIFY_TOKEN', 'DATABASE_URL', 'PHONE_ENC_KEY', 'SEND_CODE'];

const value = (env, name) => (typeof env[name] === 'string' ? env[name].trim() : '');

export function loadConfig(env) {
  const missing = REQUIRED.filter((name) => !value(env, name));
  const encKey = value(env, 'PHONE_ENC_KEY');
  if (encKey && Buffer.from(encKey, 'base64').length !== 32) missing.push('PHONE_ENC_KEY');
  return {
    enabled: missing.length === 0,
    missing,
    wa: {
      token: value(env, 'WA_TOKEN'),
      phoneNumberId: value(env, 'WA_PHONE_NUMBER_ID'),
      wabaId: value(env, 'WA_WABA_ID'),
      templateName: value(env, 'WA_TEMPLATE_NAME') || 'duty_roster_week',
      templateLang: value(env, 'WA_TEMPLATE_LANG') || 'he',
    },
    appSecret: value(env, 'WA_APP_SECRET'),
    verifyToken: value(env, 'WA_VERIFY_TOKEN'),
    databaseUrl: value(env, 'DATABASE_URL'),
    encKey,
    sendCode: value(env, 'SEND_CODE'),
    testPhone: normalizePhone(value(env, 'WA_TEST_PHONE') || null),
  };
}
