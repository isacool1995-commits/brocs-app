import nodemailer from 'nodemailer';
import { config } from './config.js';
import { logger } from './logger.js';

const transport = config.smtp ? nodemailer.createTransport(config.smtp) : null;

export async function sendMail({ to, subject, text, html }) {
  if (!transport) {
    // SMTP не настроен: письмо не уходит, администратор видит его в логе сервера
    logger.warn({ to, subject, text }, 'SMTP не настроен — письмо не отправлено');
    return false;
  }
  await transport.sendMail({ from: `${config.appName} <${config.mailFrom}>`, to, subject, text, html });
  return true;
}
