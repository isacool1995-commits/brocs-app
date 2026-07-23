-- Запустите это один раз в Supabase: ваш проект → SQL Editor → New query → Run

create table if not exists kv_store (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

-- Разрешаем приложению читать и писать (для простого внутреннего инструмента
-- этого достаточно; для более серьёзной защиты потом можно настроить RLS-политики).
alter table kv_store enable row level security;

create policy "allow all read" on kv_store
  for select using (true);

create policy "allow all write" on kv_store
  for insert with check (true);

create policy "allow all update" on kv_store
  for update using (true);

create policy "allow all delete" on kv_store
  for delete using (true);
