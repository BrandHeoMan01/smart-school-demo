-- ============================================================================
--  EDUVIA — سياسات الصلاحيات على مستوى الصفوف (Row Level Security)
--  الملف: sql/002_rls.sql
--
--  الفكرة المحورية: الأدوار السبعة في المنصّة كانت «تُخفي أزرارًا» في الواجهة.
--  هنا تُنقل إلى **فرض على مستوى البيانات** — فالصلاحية لا تُلتفّ بنداء دالة من
--  وحدة تحكّم المتصفّح.
--
--  الضمانات الثلاث لسجلّ السلوك (الدرس المضادّ لنظام Wilma) مُقنَّنة هنا:
--    ① متوازن    → kind إلزامي ∈ {pos,neg}  (001)
--    ② اعتراض    → مِشغّل يمنع التلميذة من مسّ status، ويفرض مهلة ٧ أيام واعتراضًا واحدًا
--    ③ محدَّد المدة → archive_expired_notes() بعد ١٨٠ يومًا + مِشغّل يمنع الاعتراض بعد الأرشفة
-- ============================================================================


-- ============================================================ دوال مساعدة
-- كلّها SECURITY DEFINER لسببين:
--   ① تفادي العودية اللانهائية (سياسة على profiles تستعلم profiles)
--   ② search_path مُثبَّت لتفادي هجوم تبديل المسار على دوال المُعرِّف
-- ولا تكشف شيئًا خارج صاحب الطلب: تعيد دوره/مؤسسته/تلاميذه فقط.

create or replace function public.my_role() returns user_role
  language sql stable security definer set search_path = public, pg_temp as $$
    select p.role from profiles p where p.id = auth.uid() and p.active
  $$;

create or replace function public.my_school() returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
    select p.school_id from profiles p where p.id = auth.uid() and p.active
  $$;

-- التلاميذ الذين يحقّ للطالب الحالي رؤيتهم بصفتهم «خاصّته»
-- (التلميذة → سجلّها · الولي → أبناؤه عبر جدول guardians)
create or replace function public.my_student_ids() returns uuid[]
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(array_agg(u.sid), '{}'::uuid[])
    from (
      select p.student_id as sid from profiles p
       where p.id = auth.uid() and p.student_id is not null
      union
      select g.student_id from guardians g
       where g.profile_id = auth.uid()
    ) u
  $$;

-- «طاقم» = من يعمل في المؤسسة (يرى كل تلاميذها)
create or replace function public.is_staff() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(my_role() in ('director','teacher','supervisor','reception'), false)
  $$;

-- «إشراف» = من يقرأ للرقابة (مفتّش/وصاية) أو يدير
create or replace function public.is_overseer() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(my_role() in ('director','inspector','authority'), false)
  $$;

-- من يكتب السجلات البيداغوجية
create or replace function public.can_record() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(my_role() in ('director','teacher','supervisor'), false)
  $$;

-- القاعدة الموحّدة للقراءة: نفس المؤسسة، ثم إمّا طاقم/إشراف أو تلميذة يخصّها السجلّ
create or replace function public.can_read_student(p_student uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (
      select 1 from students s
       where s.id = p_student
         and s.school_id = my_school()
         and (is_staff() or is_overseer() or p_student = any(my_student_ids()))
    )
  $$;

grant execute on function public.my_role(), public.my_school(), public.my_student_ids(),
                          public.is_staff(), public.is_overseer(), public.can_record(),
                          public.can_read_student(uuid)
  to authenticated;


-- ============================================================ المؤسسة
drop policy if exists schools_read on schools;
create policy schools_read on schools for select to authenticated
  using (id = my_school() or is_overseer());

drop policy if exists schools_update on schools;
create policy schools_update on schools for update to authenticated
  using (id = my_school() and my_role() = 'director')
  with check (id = my_school() and my_role() = 'director');


-- ============================================================ التلاميذ
drop policy if exists students_read on students;
create policy students_read on students for select to authenticated
  using (
    school_id = my_school()
    and (is_staff() or is_overseer() or id = any(my_student_ids()))
  );

-- التسجيل والتعديل: المدير والناظر والأمانة (المعلّمة لا تُسجّل تلميذات)
drop policy if exists students_insert on students;
create policy students_insert on students for insert to authenticated
  with check (school_id = my_school() and my_role() in ('director','supervisor','reception'));

drop policy if exists students_update on students;
create policy students_update on students for update to authenticated
  using (school_id = my_school() and my_role() in ('director','supervisor','reception'))
  with check (school_id = my_school());

drop policy if exists students_delete on students;
create policy students_delete on students for delete to authenticated
  using (school_id = my_school() and my_role() = 'director');


-- ============================================================ الهوية
-- قراءة: صاحب الحساب يرى نفسه دائمًا · المدير والمفتّش يرون الجميع
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select to authenticated
  using (id = auth.uid() or (school_id = my_school() and is_overseer()));

-- ⚠️ لا سياسة INSERT: الحسابات تُنشأ من الخادم (service_role) لا من المتصفّح.
--    هذا يمنع أي مستخدم من تنصيب نفسه.

-- تعديل: صاحب الحساب يعدّل ملفّه — لكن ليس **دوره**.
-- RLS لا تُقيّد الأعمدة، لذا القيد العمودي أدناه (GRANT على أعمدة بعينها) هو الحاجز:
-- بدونه تستطيع تلميذة أن تكتب role='director' في ملفّها وترى كل شيء.
revoke update on profiles from authenticated;
grant  update (display_name, phone) on profiles to authenticated;

drop policy if exists profiles_update_self on profiles;
create policy profiles_update_self on profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = my_role() and school_id = my_school());

drop policy if exists profiles_update_admin on profiles;
create policy profiles_update_admin on profiles for update to authenticated
  using (school_id = my_school() and my_role() = 'director')
  with check (school_id = my_school());


-- ============================================================ الأولياء
drop policy if exists guardians_read on guardians;
create policy guardians_read on guardians for select to authenticated
  using (
    profile_id = auth.uid()
    or exists (select 1 from students s
                where s.id = guardians.student_id
                  and s.school_id = my_school()
                  and (is_staff() or is_overseer()))
  );

drop policy if exists guardians_write on guardians;
create policy guardians_write on guardians for all to authenticated
  using (my_role() in ('director','supervisor','reception'))
  with check (my_role() in ('director','supervisor','reception'));


-- ============================================================ الطواقم
drop policy if exists staff_read on staff;
create policy staff_read on staff for select to authenticated
  using (school_id = my_school());

drop policy if exists staff_write on staff;
create policy staff_write on staff for all to authenticated
  using (school_id = my_school() and my_role() = 'director')
  with check (school_id = my_school() and my_role() = 'director');


-- ============================================================ الحضور
drop policy if exists attendance_read on attendance;
create policy attendance_read on attendance for select to authenticated
  using (can_read_student(student_id));

drop policy if exists attendance_write on attendance;
create policy attendance_write on attendance for insert to authenticated
  with check (school_id = my_school() and can_record());

drop policy if exists attendance_update on attendance;
create policy attendance_update on attendance for update to authenticated
  using (school_id = my_school() and can_record())
  with check (school_id = my_school() and can_record());


-- ============================================================ سجلّ البوابة
drop policy if exists gate_read on gate_log;
create policy gate_read on gate_log for select to authenticated
  using (school_id = my_school() and (is_staff() or is_overseer()));

drop policy if exists gate_write on gate_log;
create policy gate_write on gate_log for insert to authenticated
  with check (school_id = my_school() and my_role() in ('director','supervisor','reception'));


-- ============================================================ النقاط
-- الملاحظة المهمّة: التلميذة تقرأ نقاطها — **ولا تكتبها**. ولا أحد غير المعلم والمدير.
drop policy if exists grades_read on grades;
create policy grades_read on grades for select to authenticated
  using (can_read_student(student_id));

drop policy if exists grades_write on grades;
create policy grades_write on grades for insert to authenticated
  with check (school_id = my_school() and my_role() in ('director','teacher'));

drop policy if exists grades_update on grades;
create policy grades_update on grades for update to authenticated
  using (school_id = my_school() and my_role() in ('director','teacher'))
  with check (school_id = my_school() and my_role() in ('director','teacher'));

drop policy if exists grades_delete on grades;
create policy grades_delete on grades for delete to authenticated
  using (school_id = my_school() and my_role() = 'director');


-- ============================================================ إعداد الدفتر
drop policy if exists book_cfg_read on gradebook_config;
create policy book_cfg_read on gradebook_config for select to authenticated
  using (can_read_student(student_id));

drop policy if exists book_cfg_write on gradebook_config;
create policy book_cfg_write on gradebook_config for all to authenticated
  using (school_id = my_school() and my_role() in ('director','teacher'))
  with check (school_id = my_school() and my_role() in ('director','teacher'));


-- ============================================================ سجلّ السلوك
-- ① متوازن: kind إلزامي (001) والفئات تأتي من قائمة العميل المتوازنة 4+4
-- ② اعتراض: سياسة القراءة أدناه + المشغّل في الأسفل
-- ③ محدَّد المدة: archived_at + دالة الأرشفة
drop policy if exists notes_read on behaviour_notes;
create policy notes_read on behaviour_notes for select to authenticated
  using (can_read_student(student_id));

-- الكتابة: المعلم والمدير والناظر فقط — التلميذة لا تُنشئ ملاحظة على نفسها
drop policy if exists notes_insert on behaviour_notes;
create policy notes_insert on behaviour_notes for insert to authenticated
  with check (school_id = my_school() and can_record());

-- التعديل: صفٌّ يخصّ صاحب الطلب (للاعتراض) أو مدير/ناظر (للفصل والأرشفة).
-- تقييد **الأعمدة** يتم في المشغّل أدناه، لأن RLS لا تعرف الأعمدة.
drop policy if exists notes_update on behaviour_notes;
create policy notes_update on behaviour_notes for update to authenticated
  using (
    can_read_student(student_id)
    and (my_role() in ('director','supervisor') or student_id = any(my_student_ids()))
  )
  with check (
    can_read_student(student_id)
    and (my_role() in ('director','supervisor') or student_id = any(my_student_ids()))
  );

-- لا سياسة DELETE: الملاحظة تُؤرشف لا تُمحى — حفاظًا على سلامة السجلّ.


-- ============================================================ سجلّ التدقيق
-- إضافة فقط، عن قصد: **لا سياسة UPDATE ولا DELETE لأي دور**.
drop policy if exists audit_insert on audit_log;
create policy audit_insert on audit_log for insert to authenticated
  with check (school_id = my_school());

-- القراءة: المدير والمفتّش والوصاية (وصاحب الأثر يرى أثره)
drop policy if exists audit_read on audit_log;
create policy audit_read on audit_log for select to authenticated
  using (school_id = my_school() and (is_overseer() or actor_id = auth.uid()));


-- ============================================================ الرسائل
drop policy if exists outbox_read on outbox;
create policy outbox_read on outbox for select to authenticated
  using (school_id = my_school() and (is_staff() or is_overseer()));

drop policy if exists outbox_insert on outbox;
create policy outbox_insert on outbox for insert to authenticated
  with check (school_id = my_school() and can_record());

-- تعليم الرسالة «أُرسلت» — من الطاقم
drop policy if exists outbox_update on outbox;
create policy outbox_update on outbox for update to authenticated
  using (school_id = my_school() and is_staff())
  with check (school_id = my_school() and is_staff());


-- ============================================================ الإشعارات
drop policy if exists notif_read on notifications;
create policy notif_read on notifications for select to authenticated
  using (
    school_id = my_school()
    and (is_staff() or is_overseer()
         or student_id is null
         or student_id = any(my_student_ids()))
  );

drop policy if exists notif_insert on notifications;
create policy notif_insert on notifications for insert to authenticated
  with check (school_id = my_school() and is_staff());


-- ============================================================ الإعلانات
drop policy if exists ann_read on announcements;
create policy ann_read on announcements for select to authenticated
  using (school_id = my_school());

drop policy if exists ann_write on announcements;
create policy ann_write on announcements for all to authenticated
  using (school_id = my_school() and my_role() in ('director','supervisor'))
  with check (school_id = my_school() and my_role() in ('director','supervisor'));


-- ============================================================ الواجبات
drop policy if exists hw_read on homework;
create policy hw_read on homework for select to authenticated
  using (
    school_id = my_school()
    and (
      is_staff() or is_overseer()
      or exists (select 1 from students s
                  where s.id = any(my_student_ids()) and s.class_label = homework.class_label)
    )
  );

drop policy if exists hw_write on homework;
create policy hw_write on homework for all to authenticated
  using (school_id = my_school() and can_record())
  with check (school_id = my_school() and can_record());


-- ============================================================ الاستدعاءات
drop policy if exists summons_read on summons;
create policy summons_read on summons for select to authenticated
  using (
    school_id = my_school()
    and (is_staff() or is_overseer() or student_id = any(my_student_ids()))
  );

drop policy if exists summons_write on summons;
create policy summons_write on summons for all to authenticated
  using (school_id = my_school() and my_role() in ('director','supervisor'))
  with check (school_id = my_school() and my_role() in ('director','supervisor'));


-- ============================================================ الشكاوى
drop policy if exists complaints_read on complaints;
create policy complaints_read on complaints for select to authenticated
  using (
    school_id = my_school()
    and (is_staff() or is_overseer() or student_id = any(my_student_ids()) or created_by = auth.uid())
  );

-- التلميذة تُرسل شكوى/اقتراحًا — هذا حقّها، وهو مقصود
drop policy if exists complaints_insert on complaints;
create policy complaints_insert on complaints for insert to authenticated
  with check (school_id = my_school() and created_by = auth.uid());

drop policy if exists complaints_update on complaints;
create policy complaints_update on complaints for update to authenticated
  using (school_id = my_school() and is_staff())
  with check (school_id = my_school() and is_staff());


-- ============================================================ التفتيش والتعليمات
drop policy if exists insp_read on inspections;
create policy insp_read on inspections for select to authenticated
  using (school_id = my_school() and (is_overseer() or is_staff()));

drop policy if exists insp_write on inspections;
create policy insp_write on inspections for all to authenticated
  using (school_id = my_school() and my_role() in ('director','inspector','authority'))
  with check (school_id = my_school() and my_role() in ('director','inspector','authority'));

drop policy if exists dir_read on directives;
create policy dir_read on directives for select to authenticated
  using (school_id = my_school());

drop policy if exists dir_write on directives;
create policy dir_write on directives for all to authenticated
  using (school_id = my_school() and my_role() in ('director','inspector','authority'))
  with check (school_id = my_school() and my_role() in ('director','inspector','authority'));


-- ============================================================================
--  المشغّلات — حيث تصبح «الضمانات الثلاث» غير قابلة للالتفاف
-- ============================================================================

-- ② حقّ الاعتراض: يحدّد من يمسّ ماذا، ويفرض المهلة والاعتراض الواحد.
--    التلميذة/الولي: يكتبان reply فقط، خلال ٧ أيام، مرّة واحدة، وعلى ملاحظة قائمة.
--    المدير/الناظر: يمرّان بحرّية (فصل الاعتراض / التثبيت / الأرشفة).
create or replace function public.guard_note_update() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r user_role := my_role();
begin
  if r in ('director','supervisor') then
    return new;
  end if;

  -- كل من ليس مديرًا/ناظرًا: لا يمسّ إلا نصّ الاعتراض
  if new.status      is distinct from old.status
  or new.category    is distinct from old.category
  or new.kind        is distinct from old.kind
  or new.body        is distinct from old.body
  or new.student_id  is distinct from old.student_id
  or new.noted_on    is distinct from old.noted_on
  or new.author_id   is distinct from old.author_id then
    raise exception 'غير مسموح: يمكنك تسجيل اعتراضك على الملاحظة فقط.'
      using errcode = '42501';
  end if;

  -- لا اعتراض على ملاحظة مُلغاة أو مؤرشفة
  if old.status <> 'open' then
    raise exception 'لا يمكن الاعتراض على ملاحظة غير قائمة.' using errcode = '42501';
  end if;

  -- المهلة: ٧ أيام من تاريخ التسجيل
  if old.noted_on < current_date - interval '7 days' then
    raise exception 'انقضت مهلة الاعتراض (٧ أيام من تاريخ التسجيل).' using errcode = '42501';
  end if;

  -- اعتراض واحد لا يُعدَّل بعد تسجيله
  if old.reply is not null and new.reply is distinct from old.reply then
    raise exception 'سُجِّل اعتراضك مسبقًا ولا يمكن تعديله.' using errcode = '42501';
  end if;

  new.replied_at := now();
  return new;
end $$;

drop trigger if exists trg_guard_note_update on behaviour_notes;
create trigger trg_guard_note_update
  before update on behaviour_notes
  for each row execute function public.guard_note_update();


-- ③ محدَّد المدة: أرشفة تلقائية بعد ١٨٠ يومًا (بديل الزرّ اليدوي في الواجهة).
create or replace function public.archive_expired_notes() returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  update behaviour_notes
     set status = 'archived', archived_at = now()
   where status <> 'archived'
     and noted_on < current_date - interval '180 days';
  get diagnostics n = row_count;
  return n;
end $$;

-- جدولة يومية 03:17 إن توفّرت pg_cron (متاحة في Supabase).
-- الساعة غير مستديرة عن قصد: لا تزاحم مهامّ أخرى على الخادم.
do $$ begin
  create extension if not exists pg_cron;
  perform cron.schedule('eduvia-archive-behaviour', '17 3 * * *',
                        $cron$select public.archive_expired_notes()$cron$);
exception when others then
  raise notice 'pg_cron غير متوفّر — شغّل public.archive_expired_notes() دوريًا (أو استخدم Scheduled Edge Function).';
end $$;


-- سجلّ التدقيق: قاعدة العملية تُملأ من الخادم (actor_id) لا من العميل،
-- حتى لا ينتحل أحد صفة غيره في الأثر.
create or replace function public.stamp_audit() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.actor_id := auth.uid();
  if new.actor_name is null then
    select display_name into new.actor_name from profiles where id = auth.uid();
  end if;
  if new.actor_role is null then
    new.actor_role := my_role();
  end if;
  if new.school_id is null then
    new.school_id := my_school();
  end if;
  return new;
end $$;

drop trigger if exists trg_stamp_audit on audit_log;
create trigger trg_stamp_audit
  before insert on audit_log
  for each row execute function public.stamp_audit();
