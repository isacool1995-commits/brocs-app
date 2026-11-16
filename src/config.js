import path from 'node:path';

const env = process.env;
const port = Number(env.PORT || 3000);

export const config = {
  appName: env.APP_NAME || 'Brox Connect',
  port,
  // Публичный адрес сервиса — для ссылок на медиафайлы в webhook
  publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir: path.resolve(env.DATA_DIR || './data'),
  // Ограничение числа номеров на одну компанию (тариф)
  maxChannelsPerAccount: Number(env.MAX_CHANNELS_PER_ACCOUNT || 5),
  // Разрешить регистрацию новых компаний через сайт
  allowSignup: env.ALLOW_SIGNUP !== 'false',
  // Пауза между исходящими сообщениями одного номера (снижает риск бана)
  sendDelayMs: [Number(env.SEND_DELAY_MIN_MS || 1200), Number(env.SEND_DELAY_MAX_MS || 3000)],
  secureCookies: env.SECURE_COOKIES === 'true' || (env.PUBLIC_URL || '').startsWith('https://'),
  logLevel: env.LOG_LEVEL || 'info',
};
