-- Supabase: таблица заявок RSVP (выполнить в SQL Editor)
-- Скрипт безопасно перезапускать: сначала удаляет старые варианты таблицы.

-- 1. Удаляем обе старые таблицы (строчную и заглавную, если есть)
drop table if exists public.rsvp;
drop table if exists public."RSVP";

-- 2. Создаём правильную таблицу
create table public.rsvp (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 100),
  attendance text not null check (attendance in ('yes', 'no')),
  guests integer not null check (guests between 1 and 4),
  menu_comment text not null default '' check (char_length(menu_comment) <= 500),
  created_at timestamptz not null default now()
);

-- Чтение/запись только через service key (RLS включён, политик нет = доступ только сервису)
alter table public.rsvp enable row level security;

-- 3. Обновляем кэш API, чтобы таблица сразу стала видна
notify pgrst, 'reload schema';
