# Брокс CRM

CRM команды: воронки сделок в тенге, клиенты (бренды) с ИП/ТОО и способом оплаты, переписка WhatsApp в карточке сделки, задачи, аналитика, отделы и профили прав доступа.

## Как устроено

- `public/index.html` — само приложение, без сборки.
- `api/config.js` — отдаёт странице адрес Supabase и публичный ключ.
- `api/wa-send.js`, `api/wa-webhook.js`, `api/brox-webhook.js` — отправка и приём сообщений WhatsApp (`_inbox.js` — общая запись в сделки, `_brox.js` — клиент Brox Connect).
- `api/admin.js` — кабинет администратора на сервере: создание сотрудников с почтой и паролем, смена пароля, закрытие доступа.
- `supabase.sql` — схема базы и правила доступа (выполняется один раз в Supabase → SQL Editor).

## Настройки Vercel (Environment Variables)

| Имя | Где взять в Supabase |
|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Project Settings → API Keys → `anon` `public` |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API Keys → `service_role` (секретный, никому не передавать) |

После изменения переменных: Deployments → ⋯ → Redeploy.

## Мессенджеры

WhatsApp работает через один из двух сервисов. Выбор — в «Настройки → Мессенджеры».

**ProfitBot** (WhatsApp, Telegram, MAX): `PROFITBOT_API_KEY`, `PROFITBOT_WEBHOOK_SECRET`.
Вебхук принимает `api/wa-webhook.js` через пересылку `supabase/functions/wa-relay`.

**Brox Connect** (свой сервис, номер подключается по QR-коду, только WhatsApp):

| Имя | Где взять |
|---|---|
| `BROX_API_URL` | Адрес сервиса Brox Connect, например `https://connect.example.com` |
| `BROX_API_KEY` | Кабинет Brox Connect → «Настройки» → API-ключ |
| `BROX_WEBHOOK_SECRET` | Кабинет Brox Connect → «Настройки» → секрет webhook |

В кабинете Brox Connect в поле «Webhook» укажите `https://<адрес сайта>/api/brox-webhook`.
Номера и переписка в сделках общие для обоих сервисов, переключаться можно в любой момент.

## Первый вход

1. Откройте сайт. Пока руководителя нет, сайт сам предложит создать его аккаунт: имя, почта, пароль.
2. Сотрудников создаёте в разделе «Команда»: почта и пароль, которые вы им выдаёте.
3. «Забыли пароль?» отправляет письмо только руководителю. Чтобы ссылка из письма вела на сайт, в Supabase → Authentication → URL Configuration укажите Site URL = адрес сайта.
