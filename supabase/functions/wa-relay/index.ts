// Пересылка вебхука Profit Bot на сайт «Брокс».
// Серверы Profit Bot не достают до vercel.app, поэтому события принимает Supabase и без изменений передаёт дальше.
// Подпись X-Signature проверяет сам сайт, поэтому секрет здесь не нужен. JWT для этой функции отключён.
const TARGET = 'https://brocs-app.vercel.app/api/wa-webhook';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ ok: true, info: 'Брокс: пересылка вебхука Profit Bot' });
  }
  const body = await req.arrayBuffer();
  try {
    const r = await fetch(TARGET, {
      method: 'POST',
      headers: {
        'Content-Type': req.headers.get('content-type') || 'application/json',
        'X-Signature': req.headers.get('x-signature') || '',
      },
      body,
    });
    return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  } catch (_e) {
    return Response.json({ error: 'Сайт «Брокс» не ответил.' }, { status: 502 });
  }
});
