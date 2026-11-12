# Брокс CRM

CRM команды: воронки сделок в тенге, клиенты (бренды) с ИП/ТОО и способом оплаты, переписка WhatsApp в карточке сделки, задачи, аналитика, отделы и профили прав доступа.

## Как устроено

- `public/index.html` — само приложение, без сборки.
- `api/config.js` — отдаёт странице адрес Supabase и публичный ключ.
- `api/admin.js` — кабинет администратора на сервере: создание сотрудников с почтой и паролем, смена пароля, закрытие доступа.
- `supabase.sql` — схема базы и правила доступа (выполняется один раз в Supabase → SQL Editor).

## Настройки Vercel (Environment Variables)

| Имя | Где взять в Supabase |
|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Project Settings → API Keys → `anon` `public` |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API Keys → `service_role` (секретный, никому не передавать) |

После изменения переменных: Deployments → ⋯ → Redeploy.

## Первый вход

1. Supabase → Authentication → Users → Add user → Create new user: ваша почта и пароль, галочка «Auto Confirm User».
2. Откройте сайт и войдите. Первый вошедший становится администратором.
3. Дальше сотрудников создаёте в разделе «Команда».
