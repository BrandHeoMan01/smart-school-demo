-- ============================================================================
--  محاكي Supabase — **للتجريب المحلي فقط**
--  الملف: tests/supabase-shim.sql
--
--  Supabase يوفّر تلقائيًا مخطط `auth` والدالة `auth.uid()` والدورين
--  `anon` و`authenticated`. ملفّات sql/001 وsql/002 تعتمد عليها.
--  هذا الملف يُنشئها على PostgreSQL عادي حتى نُشغّل سياسات RLS فعليًا
--  في الاختبار المحلي بدل الاكتفاء بقراءتها.
--
--  ⚠️ لا يُشغَّل على Supabase — فهناك موجودة سلفًا.
--     التعريف هنا منسوخ من تعريف Supabase الرسمي لتبقى المحاكاة أمينة.
-- ============================================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ الأدوار
do $$ begin create role anon nologin;        exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;

grant usage on schema public to anon, authenticated, service_role;

-- ------------------------------------------------------------------ مخطط auth
create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

-- تعريف auth.uid() مطابق لمنطق Supabase: يقرأ المُعرِّف من إعدادات الجلسة
-- (Supabase يضعها من توكن JWT؛ نحن نضعها يدويًا في الاختبار).
create or replace function auth.uid() returns uuid
  language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims',    true), '')::jsonb ->> 'sub'
    )::uuid
  $$;

-- Supabase يمنح authenticated صلاحيات على جداول public افتراضيًا؛ نحاكي ذلك.
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
