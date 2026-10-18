// WhatsApp sending configuration from env vars. Any missing/invalid required var → sending disabled
// (the rest of the site works as before). Only var NAMES are ever reported, never values.
// WA_FAKE=1 (local development only, ignored when NODE_ENV=production): sending enabled with an
// in-memory repo and a fake WhatsApp client — nothing is sent anywhere.
import { normalizePhone } from '../src/core/phones.js';

const REQUIRED = ['WA_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_WABA_ID', 'WA_APP_SECRET', 'WA_VERIFY_TOKEN', 'DATABASE_URL', 'PHONE_ENC_KEY', 'SEND_CODE'];
const FAKE_SEND_CODE = '1234';
const FAKE_TEST_PHONE = '972500000000';

const value = (env, name) => (typeof env[name] === 'string' ? env[name].trim() : '');

export function loadConfig(env) {
  const fake = value(env, 'WA_FAKE') === '1' && value(env, 'NODE_ENV') !== 'production';
  const missing = fake ? [] : REQUIRED.filter((name) => !value(env, name));
  const encKey = value(env, 'PHONE_ENC_KEY');
  if (!fake && encKey && Buffer.from(encKey, 'base64').length !== 32) missing.push('PHONE_ENC_KEY');
  return {
    enabled: missing.length === 0,
    fake,
    missing,
    wa: {
      token: value(env, 'WA_TOKEN'),
      phoneNumberId: value(env, 'WA_PHONE_NUMBER_ID'),
      wabaId: value(env, 'WA_WABA_ID'),
      templatePrefix: value(env, 'WA_TEMPLATE_PREFIX') || 'duty_roster_days_',
      templateLang: value(env, 'WA_TEMPLATE_LANG') || 'he',
    },
    appSecret: value(env, 'WA_APP_SECRET'),
    verifyToken: value(env, 'WA_VERIFY_TOKEN'),
    databaseUrl: value(env, 'DATABASE_URL'),
    encKey,
    sendCode: value(env, 'SEND_CODE') || (fake ? FAKE_SEND_CODE : ''),
    testPhone: normalizePhone(value(env, 'WA_TEST_PHONE') || (fake ? FAKE_TEST_PHONE : null)),
  };
}
