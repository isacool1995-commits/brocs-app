# Brox Connect

Сервис для подключения WhatsApp к CRM, по модели Wazzup.

- Компания регистрируется в личном кабинете и подключает свои номера по QR-коду.
  Номер работает как «связанное устройство» WhatsApp Web.
- Сервис пересылает входящие сообщения в CRM компании через **webhook**.
- CRM отправляет ответы через **REST API** с ключом компании.
- Сотрудниками и правами доступа к номерам управляет CRM: в каждом событии есть `channelId`,
  по которому CRM решает, кому из сотрудников показать диалог.
- В кабинете есть окно чатов, чтобы проверить номер до подключения CRM.

> ⚠️ Это неофициальный способ, он нарушает правила WhatsApp. Номера могут заблокировать,
> особенно при рассылках и холодных сообщениях. Предупреждайте об этом клиентов.
>
> Слово «WhatsApp» нельзя использовать в названии продукта и логотипе: это товарный знак Meta.
> Название меняется переменной `APP_NAME`.

## Запуск

Нужен Node.js 22.13 или новее (используется встроенный SQLite).

```bash
npm install
cp .env.example .env
npm start
```

1. Откройте http://localhost:3000 и зарегистрируйте компанию. API-ключ показывается один раз, сохраните его.
2. На вкладке «Номера» нажмите «Подключить номер».
3. На телефоне откройте WhatsApp → Настройки → Связанные устройства → Привязка устройства и отсканируйте QR-код.
4. На вкладке «Интеграция» укажите адрес webhook вашей CRM и нажмите «Проверить».

### Восстановление пароля

На странице входа есть ссылка «Забыли пароль?». Пользователь получает письмо со ссылкой,
она действует 1 час и срабатывает один раз. После смены пароля выполняется выход на всех устройствах.
Для отправки писем заполните `SMTP_*` в `.env`. Подойдёт любая почта с SMTP:
Яндекс, Mail.ru, Gmail (с паролем приложения), Unisender и другие.
Пока SMTP не настроен, ссылка сброса записывается в лог сервера.

Сменить пароль можно в кабинете: «Настройки» → «Смена пароля».

### Продакшен

Сервису нужен постоянно работающий процесс и постоянный диск, поэтому **Vercel и другие serverless-платформы не подходят**.
Подойдёт VPS, Railway, Render или Fly.io, но обязательно с постоянным томом для `data/`.

```bash
docker build -t brox-connect .
docker run -d --name brox -p 3000:3000 -v brox-data:/app/data \
  -e PUBLIC_URL=https://connect.example.com brox-connect
```

Поставьте перед сервисом HTTPS (nginx, Caddy). В `data/` лежат база, медиафайлы и ключи сессий
всех номеров: делайте её резервные копии и никому не давайте к ней доступа.

## API v1

Базовый адрес: `https://<ваш-домен>/api/v1`. Авторизация: заголовок `Authorization: Bearer brx_...`.

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/account` | Данные компании |
| GET | `/channels` | Номера и их статусы |
| POST | `/channels` `{ "name": "Продажи" }` | Добавить номер. QR (data URL) появится в поле `qr` у `GET /channels/:id` |
| GET | `/channels/:id` | Статус и QR |
| PATCH | `/channels/:id` `{ "name": "…" }` | Переименовать |
| POST | `/channels/:id/relink` | Новый QR, если номер отвязали на телефоне |
| DELETE | `/channels/:id` | Отвязать и удалить номер вместе с историей |
| GET | `/channels/:id/chats?limit=50` | Диалоги с последним сообщением |
| GET | `/channels/:id/messages?chat=79991234567&limit=50&before=<ts>` | История диалога, от новых к старым |
| POST | `/channels/:id/messages` | Отправить сообщение |
| POST | `/account/webhook-test` | Отправить в CRM тестовое событие `ping` |
| GET | `/events` | Поток событий (SSE), удобно для отладки |

Статусы номера: `starting`, `qr`, `connected`, `reconnecting`, `logged_out`, `stopped`.

### Отправка

```json
{ "to": "79991234567", "text": "Здравствуйте!" }
{ "to": "79991234567", "type": "image", "url": "https://…/photo.jpg", "caption": "Каталог" }
{ "to": "79991234567", "type": "document", "url": "https://…/price.pdf", "fileName": "Прайс.pdf" }
{ "to": "79991234567", "type": "audio", "url": "https://…/voice.ogg", "voice": true }
{ "to": "120363…@g.us", "text": "Сообщение в группу" }
```

Ответ: `{ "messageId": "3EB0…", "chat": "79991234567", "timestamp": 1700000000000 }`.
Сообщения одного номера уходят по очереди с паузой 1,2–3 с.

## Webhook

Сервис отправляет `POST` с JSON на адрес, указанный в кабинете:

```json
{
  "event": "message.incoming",
  "channelId": "ch_huvBSbIOyS0",
  "timestamp": 1700000000000,
  "data": {
    "messageId": "3EB0…",
    "fromMe": false,
    "chat": "79991234567",
    "isGroup": false,
    "from": "79991234567",
    "senderName": "Иван",
    "isLid": false,
    "timestamp": 1700000000000,
    "type": "text",
    "text": "Сколько стоит доставка?",
    "quotedMessageId": null
  }
}
```

| Событие | Когда приходит |
|---|---|
| `message.incoming` | Клиент написал |
| `message.outgoing` | Сотрудник ответил прямо с телефона |
| `message.status` | `{ messageId, chat, status }`, где `status` = `sent` / `delivered` / `read` / `played` / `error` |
| `channel.status` | Номер подключился, ждёт QR, переподключается, отвязан или удалён |
| `ping` | Проверка из кабинета |

Значения `type`: `text`, `image`, `video`, `audio`, `document`, `sticker`, `location`, `contact`, `reaction`.
У медиа есть поле `media: { url, mimetype, fileName, size }`. Файл скачивается по `url` с тем же API-ключом.

`chat` — это ID диалога: номер телефона, `…@lid`, если WhatsApp скрыл номер, или `…@g.us` для группы.
На этот же ID можно отвечать через поле `to`.

**Подпись:** `X-Signature` = HMAC-SHA256(сырое тело запроса, секрет webhook), в hex.
Пример проверки на Node.js:

```js
const sig = crypto.createHmac('sha256', process.env.BROX_WEBHOOK_SECRET).update(rawBody).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(req.headers['x-signature'] || ''))) return res.status(401).end();
```

Если CRM отвечает не 2xx, сервис повторяет отправку до 5 раз с нарастающей паузой.

## Структура

```
src/server.js     HTTP: вход в кабинет, API v1, медиа
src/accounts.js   компании, пароли (scrypt), сессии, API-ключи (хранятся только хеши)
src/channels.js   подключения WhatsApp (Baileys), приём и отправка сообщений, история
src/webhook.js    доставка событий в CRM: очередь на компанию, подпись, повторы
src/mailer.js     письма (восстановление пароля)
src/db.js         схема SQLite
public/           личный кабинет
```
