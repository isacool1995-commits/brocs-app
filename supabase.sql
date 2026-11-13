-- Брокс CRM: схема базы. Запускается один раз в Supabase → SQL Editor.

create table if not exists public.docs (
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
alter table public.docs enable row level security;

create or replace function public.docs_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs for each row execute function public.docs_touch();

-- Карточка текущего сотрудника
create or replace function public.me() returns jsonb
language sql stable security definer set search_path = public as $$
  select data from docs where col = 'members' and id = auth.uid()::text
$$;

-- Профиль доступа текущего сотрудника; null — нет доступа (не в команде или заблокирован)
create or replace function public.my_role() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m jsonb; r jsonb; rid text;
begin
  m := public.me();
  if m is null or coalesce((m->>'blocked')::boolean, false) then return null; end if;
  rid := coalesce(nullif(m->>'access', ''), case when m->>'role' = 'Руководитель' then 'r_admin' else 'r_manager' end);
  if rid = 'r_admin' then return '{"manage": true}'::jsonb; end if;
  select data into r from docs where col = 'roles' and id = rid;
  if r is null then select data into r from docs where col = 'roles' and id = 'r_manager'; end if;
  return coalesce(r, '{}'::jsonb);
end $$;

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() is not null
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((public.my_role()->>'manage')::boolean, false)
$$;

-- Может ли текущий сотрудник выполнить действие act над записью d из коллекции c
create or replace function public.can_do(c text, act text, d jsonb) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare r jsonb; lvl text; mydept text; odept text; pid text;
begin
  r := public.my_role();
  if r is null then return false; end if;
  if coalesce((r->>'manage')::boolean, false) then return true; end if;
  if c = 'deals' and jsonb_typeof(r->'pipes') = 'array' then
    pid := coalesce(nullif(d->>'pipeline', ''), 'main');
    if not (r->'pipes' ? pid) then return false; end if;
  end if;
  lvl := coalesce(r->'perms'->c->>act, 'none');
  if lvl = 'all' then return true; end if;
  if lvl = 'none' then return false; end if;
  if act = 'create' then return true; end if;
  if d->>'owner' = auth.uid()::text then return true; end if;
  if lvl = 'dept' then
    mydept := public.me()->>'dept';
    select data->>'dept' into odept from docs where col = 'members' and id = d->>'owner';
    return coalesce(mydept, '') <> '' and mydept = odept;
  end if;
  return false;
end $$;

drop policy if exists docs_select on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;

create policy docs_select on public.docs for select to authenticated using (
  case when col in ('members','pipelines','depts','roles','config') then public.is_active()
       else public.can_do(col, 'view', data) end);

create policy docs_insert on public.docs for insert to authenticated with check (
  case when col in ('members','pipelines','depts','roles','config') then public.is_admin()
       else public.can_do(col, 'create', data) end);

create policy docs_update on public.docs for update to authenticated using (
  case when col in ('members','pipelines','depts','roles','config') then public.is_admin()
       else public.can_do(col, 'edit', data) end)
  with check (
  case when col in ('members','pipelines','depts','roles','config') then public.is_admin()
       else public.is_active() end);

create policy docs_delete on public.docs for delete to authenticated using (
  case when col in ('members','pipelines','depts','roles','config') then public.is_admin()
       else public.can_do(col, 'del', data) end);

grant select, insert, update, delete on public.docs to authenticated;
revoke all on public.docs from anon;

-- Живые обновления у всех открытых вкладок
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- Начальные профили доступа и отделы
insert into public.docs (col, id, data) values
('roles','r_admin','{"name":"Администратор","manage":true,"reports":true,"pipes":"all","order":0,"perms":{"deals":{"create":"all","view":"all","edit":"all","del":"all"},"contacts":{"create":"all","view":"all","edit":"all","del":"all"},"companies":{"create":"all","view":"all","edit":"all","del":"all"},"tasks":{"create":"all","view":"all","edit":"all","del":"all"}}}'),
('roles','r_manager','{"name":"Менеджер","manage":false,"reports":false,"pipes":"all","order":1,"perms":{"deals":{"create":"all","view":"dept","edit":"own","del":"none"},"contacts":{"create":"all","view":"all","edit":"own","del":"none"},"companies":{"create":"all","view":"all","edit":"own","del":"none"},"tasks":{"create":"all","view":"own","edit":"own","del":"own"}}}'),
('roles','r_intern','{"name":"Стажёр","manage":false,"reports":false,"pipes":"all","order":2,"perms":{"deals":{"create":"all","view":"own","edit":"own","del":"none"},"contacts":{"create":"all","view":"own","edit":"own","del":"none"},"companies":{"create":"all","view":"own","edit":"own","del":"none"},"tasks":{"create":"all","view":"own","edit":"own","del":"none"}}}'),
('depts','d_sales','{"name":"Отдел продаж","order":0}'),
('depts','d_reg','{"name":"Отдел регистрации","order":1}'),
('depts','d_tech','{"name":"Техобслуживание","order":2}')
on conflict (col, id) do nothing;
-- Безопасность: белый список IP проверяется на сервере. Администратор под ограничение не попадает.
create or replace function public.client_ip() returns text
language sql stable as $$
  select nullif(trim(split_part(coalesce(
    current_setting('request.headers', true)::json->>'x-forwarded-for',
    current_setting('request.headers', true)::json->>'cf-connecting-ip', ''), ',', 1)), '')
$$;

create or replace function public.my_role() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m jsonb; r jsonb; rid text; sec jsonb; ip text;
begin
  m := public.me();
  if m is null or coalesce((m->>'blocked')::boolean, false) then return null; end if;
  rid := coalesce(nullif(m->>'access', ''), case when m->>'role' = 'Руководитель' then 'r_admin' else 'r_manager' end);
  if rid = 'r_admin' then return '{"manage": true}'::jsonb; end if;
  select data into sec from docs where col = 'config' and id = 'security';
  if coalesce((sec->>'ipEnabled')::boolean, false) then
    ip := public.client_ip();
    if ip is null or not (coalesce(sec->'ips', '[]'::jsonb) ? ip) then return null; end if;
  end if;
  select data into r from docs where col = 'roles' and id = rid;
  if r is null then select data into r from docs where col = 'roles' and id = 'r_manager'; end if;
  return coalesce(r, '{}'::jsonb);
end $$;
-- Почта: подключённые ящики (только для сервера) и права на письма
create table if not exists public.mail_accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  imap_host text not null,
  imap_port int not null default 993,
  smtp_host text not null,
  smtp_port int not null default 465,
  login text not null,
  pass_enc text not null,
  last_uid bigint not null default 0,
  uidvalidity bigint,
  created_at timestamptz not null default now()
);
alter table public.mail_accounts enable row level security;
revoke all on public.mail_accounts from anon, authenticated;

create or replace function public.can_mail() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((public.my_role()->>'manage')::boolean, false) or coalesce((public.my_role()->>'mail')::boolean, false)
$$;

drop policy if exists docs_select on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;

create policy docs_select on public.docs for select to authenticated using (
  case when col in ('members','pipelines','depts','roles','config') then public.is_active()
       when col = 'mail' then public.can_mail()
       else public.can_do(col, 'view', data) end);

create policy docs_insert on public.docs for insert to authenticated with check (
  case when col in ('members','pipelines','depts','roles','config') then public.is_admin()
       when col = 'mail' then public.can_mail()
       else public.can_do(col, 'create', data) end);

create policy docs_update on public.docs for update to authenticated using (
  case when col in ('members','pipelines','depts','roles','config') then public.is_admin()
       when col = 'mail' then public.can_mail()
       else public.can_do(col, 'edit', data) end)
  with check (
  case when col in ('members','pipelines','depts','roles','config') then public.is_admin()
       when col = 'mail' then public.can_mail()
       else public.is_active() end);

create policy docs_delete on public.docs for delete to authenticated using (
  case when col in ('members','pipelines','depts','roles','config') then public.is_admin()
       when col = 'mail' then public.is_admin()
       else public.can_do(col, 'del', data) end);

-- Переписка из мессенджеров: видна тем, кто видит сделку. Пишет только сервер.
create or replace function public.can_see_chat(d jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from docs x where x.col = 'deals' and x.id = d->>'deal' and public.can_do('deals', 'view', x.data))
$$;

drop policy if exists docs_select on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;

create policy docs_select on public.docs for select to authenticated using (
  case when col in ('members','pipelines','depts','roles','config') then public.is_active()
       when col = 'mail' then public.can_mail()
       when col = 'chat' then public.can_see_chat(data)
       else public.can_do(col, 'view', data) end);

create policy docs_insert on public.docs for insert to authenticated with check (
  case when col in ('members','pipelines','depts','roles','config') then public.is_admin()
       when col = 'mail' then public.can_mail()
       when col = 'chat' then public.is_admin()
       else public.can_do(col, 'create', data) end);

create policy docs_update on public.docs for update to authenticated using (
  case when col in ('members','pipelines','depts','roles','config') then public.is_admin()
       when col = 'mail' then public.can_mail()
       when col = 'chat' then public.is_admin()
       else public.can_do(col, 'edit', data) end)
  with check (
  case when col in ('members','pipelines','depts','roles','config') then public.is_admin()
       when col = 'mail' then public.can_mail()
       when col = 'chat' then public.is_admin()
       else public.is_active() end);

create policy docs_delete on public.docs for delete to authenticated using (
  case when col in ('members','pipelines','depts','roles','config','mail','chat') then public.is_admin()
       else public.can_do(col, 'del', data) end);

