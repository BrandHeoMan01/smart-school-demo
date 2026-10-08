-- ============================================================================
--  EDUVIA — إضافة ٥: إصلاح فهرس client_id ليصلح للمزامنة فعلًا
--  الملف: sql/005_client_id_unique.sql
--
--  العَرَض: لا شيء يُزامَن إطلاقًا في الوضع الموصول (حضور · سلوك · شكاوى ·
--          تدقيق · صادر) مع أنّ مؤشّر الحالة يقف على «جارٍ المزامنة».
--
--  السبب: المخطّط 001 أنشأ فهرسًا فريدًا **جزئيًّا**:
--            create unique index … on t(client_id) where client_id is not null;
--        والطابور في العميل يستعمل upsert بمفتاح client_id، أي:
--            POST … ?on_conflict=client_id   →   INSERT … ON CONFLICT (client_id)
--        وPostgres **لا يستطيع** مطابقة فهرس جزئي بهذا الشرط، فيرفض الطلب:
--            42P10: there is no unique or exclusion constraint
--                   matching the ON CONFLICT specification
--
--  الأثر المزدوج (وهو ما جعله خفيًّا):
--    ① كل صفّ يفشل — لا صفّ واحد بعينه.
--    ② أول صفّ في الطابور يبقى في رأسه، فيتوقّف **كل ما خلفه** إلى الأبد.
--       فيبدو الأثر «لم يُرسَل» وهو في الحقيقة «لم يُجرَّب أصلًا».
--
--  الإصلاح: فهرس **كامل** (بلا شرط). وهو آمن تمامًا هنا: في Postgres كل قيم
--  NULL **متميّزة**، فيسمح الفهرس الكامل بصفوف بذرةٍ كثيرة بـclient_id = null
--  (وهي كلها كذلك) ويمنع في الوقت نفسه ازدواج أي client_id غير فارغ.
--
--  إضافيّ ومحميّ: يُشغَّل أكثر من مرّة بأمان، ولا يمسّ صفًّا واحدًا من بياناتك.
-- ============================================================================

do $$
declare
  t    text;
  d    bigint;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join pg_tables p
        on p.schemaname = c.table_schema and p.tablename = c.table_name
     where c.table_schema = 'public' and c.column_name = 'client_id'
     order by c.table_name
  loop
    /* الجزئيّ القديم يُزال — هو ما كان يمنع ON CONFLICT */
    execute format('drop index if exists public.%I', t || '_client_id_key');
    execute format('drop index if exists public.%I', t || '_client_id_uniq');

    /* حارس: لو كان في الجدول client_id مكرّر لفشل إنشاء الفهرس الفريد
       برسالة غامضة. نفحص ونشرح بدلًا من ذلك. */
    execute format(
      'select count(*) from (select client_id from public.%I
         where client_id is not null
         group by client_id having count(*) > 1) x', t) into d;
    if d > 0 then
      raise exception 'الجدول % فيه % client_id مكرّر — نظّفه ثم أعد التشغيل.', t, d;
    end if;

    execute format('create unique index %I on public.%I (client_id)',
                   t || '_client_id_uniq', t);
    raise notice '✔ % — فهرس فريد كامل على client_id', t;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
--  تحقّق: يجب أن تظهر صفوف client_id_uniq وبلا أيّ indpred (شرط جزئي).
--  لو ظهر عمود pred غير فارغ فالفهرس ما زال جزئيًّا.
-- ---------------------------------------------------------------------------
select c.relname as "الجدول",
       i.indexrelid::regclass::text as "الفهرس",
       i.indisunique as "فريد",
       coalesce(pg_get_expr(i.indpred, i.indrelid), '—') as "شرط جزئي"
  from pg_index i
  join pg_class c on c.oid = i.indrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and pg_get_indexdef(i.indexrelid) ilike '%client_id%'
 order by c.relname;
