-- ============================================================================
--  EDUVIA — ٦: الإصلاحان معًا في لصقةٍ واحدة (٢ من العميل · ٥ من الفهرس)
--  الملف: sql/006_apply_004_and_005.sql
--
--  لماذا ملفٌّ واحد؟
--    لأنّ التشغيل المتكرّر لملفّين = فرصتان للفشل الصامت. هنا لصقةٌ واحدة تُنجِز
--    كل شيء، **ولا يمكن أن تفشل صامتة**: كل جدول يُعالَج في كتلته المحميّة، ولو
--    تعثّر واحدٌ لَما أوقف الباقي، ولَظهر سببه في التقرير في الأسفل.
--
--  ماذا يفعل؟
--    ① يُضيف عمودَي target وanonymous للشكاوى، ويُضيف مشغّل وسم الكاتب.
--    ② يُبدّل فهرس client_id من **جزئيّ** إلى **كامل** على كل جدول.
--
--  ولماذا ② هو الأهمّ؟
--    الطابور يُرسل upsert بمفتاح client_id، أي INSERT … ON CONFLICT (client_id).
--    وPostgres **لا يستطيع** مطابقة فهرسٍ جزئيّ بهذا الشرط، فيرفض كل صفّ:
--        42P10: there is no unique or exclusion constraint matching the
--               ON CONFLICT specification
--    والفهرس الكامل آمنٌ تمامًا هنا: في Postgres كل قيم NULL **متميّزة**، فيسمح
--    الفهرس الكامل بصفوف البذرة كلها (وهي client_id = null) ويمنع في الوقت نفسه
--    ازدواج أي client_id غير فارغ.
--
--  إضافيّ محض ومحميّ: يُشغَّل أكثر من مرّة بأمان، ولا يحذف صفًّا واحدًا.
--  (ولو وُجد client_id مكرّر — وهو مستحيل مع الفهرس القديم — يُفرَّغ العمود من
--   النسخة الأقدم وتبقى البيانات كما هي. لا حذف.)
--
--  التشغيل: Supabase ← SQL Editor ← New query ← الصق الكتلة **كاملة** ← Run.
--  ثم: انتظر حتى تظهر نتيجتان في الأسفل.  إن ظهر ✖ بجانب جدول فأخبرني به.
-- ============================================================================


-- ─────────────────────────────────────────────────────── ①الشكاوى: عمودان ──
alter table public.complaints
  add column if not exists target    text,
  add column if not exists anonymous boolean not null default false;

comment on column public.complaints.target    is 'جهة الشكوى: أستاذ · النظافة · الساحة … (فئة توجيه)';
comment on column public.complaints.anonymous is 'أرسلتها التلميذة بلا كشف اسمها';

-- ---------------------------------------------------------------------------
--  وسم كاتب الصفّ من الخادم.
--  سياسة الإدراج تشترط created_by = auth.uid() حتى لا يكتب أحدٌ باسم غيره.
--  والمشغّل يضمن ذلك **على الخادم**: العميل لا يستطيع تزوير المالك.
--  وهو نفس نمط stamp_school وstamp_audit في الملفّ 002.
-- ---------------------------------------------------------------------------
create or replace function public.stamp_creator() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.created_by is null then new.created_by := auth.uid(); end if;
  return new;
end $$;

do $trg$
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
    begin
      execute format('drop trigger if exists trg_stamp_creator on public.%I', t);
      execute format(
        'create trigger trg_stamp_creator before insert on public.%I
           for each row execute function public.stamp_creator()', t);
    exception when others then
      raise notice '✖ وسم الكاتب على %: %', t, sqlerrm;
    end;
  end loop;
end $trg$;


-- ───────────────────────────────────── ②فهرس client_id: جزئيّ ← كامل ──────
do $fix$
declare
  t   text;
  idx record;
  n   bigint;
  log text := '';
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join pg_tables p
        on p.schemaname = c.table_schema and p.tablename = c.table_name
     where c.table_schema = 'public' and c.column_name = 'client_id'
     order by c.table_name
  loop
    /* كل جدول في كتلته المحميّة: جدولٌ متعثّر لا يُسقِط الباقي */
    begin
      /* نُسقط أيّ فهرس قائم على العمود client_id وحده — **بالعمود لا بالاسم**،
         لأنّ الأسماء لا تُتَّبَع نمطًا واحدًا (فهرس audit_log اسمه
         audit_client_id_key لا audit_log_client_id_key). */
      for idx in
        select ic.relname as nm
          from pg_index i
          join pg_class     tbl on tbl.oid = i.indrelid
          join pg_class     ic  on ic.oid  = i.indexrelid
          join pg_namespace ns  on ns.oid  = tbl.relnamespace
         where ns.nspname = 'public'
           and tbl.relname = t
           and i.indnatts = 1
           and i.indkey[0] = (select a.attnum from pg_attribute a
                               where a.attrelid = tbl.oid and a.attname = 'client_id')
      loop
        execute format('drop index if exists public.%I', idx.nm);
      end loop;

      /* حارس غير مُدمِّر: لو تكرّر client_id (لا يحدث مع الفهرس القديم، لكن
         احتياطًا لجدولٍ بلا فهرس) يُفرَّغ من النسخة الأقدم. لا حذف لبيانات. */
      execute format(
        'update public.%I set client_id = null
          where ctid in (
            select ctid from (
              select ctid,
                     row_number() over (partition by client_id order by ctid desc) rn
                from public.%I
               where client_id is not null
            ) z
            where z.rn > 1)', t, t);
      get diagnostics n = row_count;
      if n > 0 then
        log := log || format(E'\n  ⚠ %s: أُفرغ client_id من %s صفًّا مكرّرًا (البيانات باقية)', t, n);
      end if;

      /* اسم الفهرس **غير مؤهَّل بالمخطّط**: Postgres يمنعه في CREATE INDEX،
         ويضعه تلقائيًّا في مخطّط الجدول نفسه. */
      execute format('create unique index %I on public.%I (client_id)',
                     t || '_client_id_uniq', t);
      log := log || format(E'\n  ✔ %s', t);
    exception when others then
      log := log || format(E'\n  ✖ %s: %s [%s]', t, sqlerrm, sqlstate);
    end;
  end loop;

  raise notice 'نتيجة إصلاح client_id:%', log;
end $fix$;

/* PostgREST يخزّن المخطّط مؤقّتًا — نطلب منه إعادة قراءته فورًا */
notify pgrst, 'reload schema';


-- ───────────────────────────────────────────────────────── التقرير ─────────
-- (١) عمودا الشكاوى — يجب أن يظهر target وanonymous
select column_name as "عمود الشكاوى", data_type as "النوع", is_nullable as "يقبل الفراغ"
  from information_schema.columns
 where table_schema = 'public' and table_name = 'complaints'
 order by ordinal_position;

-- (٢) فهارس client_id — «شرطٌ جزئيّ» يجب أن يكون «—» في كل صفّ.
--     إن ظهر شرطٌ فالفهرس ما زال جزئيًّا والأصل لم يُطبَّق.
select c.relname                          as "الجدول",
       i.indexrelid::regclass::text       as "الفهرس",
       i.indisunique                      as "فريد",
       coalesce(pg_get_expr(i.indpred, i.indrelid), '—') as "شرطٌ جزئيّ"
  from pg_index i
  join pg_class     c  on c.oid = i.indrelid
  join pg_namespace ns on ns.oid = c.relnamespace
 where ns.nspname = 'public'
   and pg_get_indexdef(i.indexrelid) ilike '%client_id%'
 order by c.relname;
