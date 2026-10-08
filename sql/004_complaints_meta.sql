-- ============================================================================
--  EDUVIA — إضافة ٤: عمودا «هدف الشكوى» و«إخفاء الهوية»
--  الملف: sql/004_complaints_meta.sql
--
--  لماذا ملفٌّ منفصل؟
--    الملفّان 001 و002 نُفِّذا على مشروعك الحيّ بالفعل. إعادة تشغيلهما كاملين
--    ليست خطوةً آمنة، ولا نحتاجها: هذا الملفّ **إضافيّ محض** — لا يحذف شيئًا
--    ولا يُغيّر صفًّا قائمًا. يُشغَّل مرّةً واحدة، ويمكن تشغيله أكثر من مرّة
--    بأمان (كل الجمل محميّة بـif not exists).
--
--  الأثر إن لم يُشغَّل:
--    المنصّة تعمل كاملة. الفرق أنّ «هدف» الشكوى (أستاذ · النظافة · الساحة…)
--    يُخزَّن في متن الرسالة بدل عمودٍ له. الواجهة تكتشف ذلك من نفسها وتُخبرك.
--
--  التشغيل: SQL Editor ← New query ← الصق الكتلة كاملة ← Run.
-- ============================================================================

alter table public.complaints
  add column if not exists target    text,
  add column if not exists anonymous boolean not null default false;

comment on column public.complaints.target    is 'جهة الشكوى: أستاذ · النظافة · الساحة … (فئة توجيه)';
comment on column public.complaints.anonymous is 'أرسلتها التلميذة بلا كشف اسمها';

-- ---------------------------------------------------------------------------
--  وسم كاتب الصفّ من الخادم.
--  سياسة الإدراج تشترط created_by = auth.uid() حتى لا يكتب أحدٌ باسم غيره.
--  والمشغّل يضمن ذلك **على الخادم**: العميل لا يستطيع تزوير المالك، ولو أرسل
--  قيمةً أخرى لَما أمكنه تجاوز الشروط (with check يُقاس على الصفّ النهائي).
--  وهو نفس نمط stamp_school وstamp_audit في الملفّ 002.
-- ---------------------------------------------------------------------------
create or replace function public.stamp_creator() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end $$;

do $$
declare t text;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join pg_tables p
        on p.schemaname = c.table_schema and p.tablename = c.table_name
     where c.table_schema = 'public'
       and c.column_name = 'created_by'
  loop
    execute format('drop trigger if exists trg_stamp_creator on public.%I', t);
    execute format(
      'create trigger trg_stamp_creator before insert on public.%I
         for each row execute function public.stamp_creator()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
--  تحقّق: يجب أن يظهر العمودان أدناه.
-- ---------------------------------------------------------------------------
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'complaints'
 order by ordinal_position;
