-- ============================================================================
--  EDUVIA — المخطط الأساسي (Supabase / PostgreSQL)
--  الملف: sql/001_schema.sql
--
--  مبادئ التصميم المُلزمة (مستمدّة من التقرير المرجعي — لا تُنقَض):
--   ① المفاتيح اللاتينية + التسميات العربية في العميل  → لا تعريب داخل قاعدة البيانات
--   ② عمود client_id على كل جدول قابل للتغيير           → مفتاح منع التكرار عند إعادة المزامنة
--   ③ grades.kind = summative|formative                 → التكويني لا يدخل المعدّل (الدرس الفنلدي 3.6)
--   ④ behaviour_notes: متوازن + قابل للاعتراض + محدَّد المدة (الدرس المضادّ 4.1)
--   ⑤ audit_log: إضافة فقط — لا تعديل ولا حذف لأي دور
--
--  ملاحظة أمنية: RLS مُفعَّل هنا (001) والسياسات في (002).
--  الترتيب مقصود: إن نُفِّذ 001 وحده بقيت الجداول **مقفلة** (منع افتراضي) لا مكشوفة.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- الأنواع
do $$ begin
  create type user_role as enum
    ('director','teacher','supervisor','reception','inspector','authority','student','parent');
exception when duplicate_object then null; end $$;

do $$ begin
  create type att_state as enum ('present','absent','late','pending');
exception when duplicate_object then null; end $$;

do $$ begin
  create type grade_kind as enum ('summative','formative');
exception when duplicate_object then null; end $$;

do $$ begin
  create type note_kind as enum ('pos','neg');
exception when duplicate_object then null; end $$;

do $$ begin
  create type note_status as enum ('open','revoked','archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type msg_channel as enum ('app','sms','call');
exception when duplicate_object then null; end $$;

do $$ begin
  create type msg_status as enum ('queued','sent','failed');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- المؤسسة
create table if not exists schools (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text not null unique,          -- "EDUVIA-NOUR" — مفتاح المؤسسة اليدوي
  wilaya      text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- التلاميذ
create table if not exists students (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references schools(id) on delete cascade,
  card_no       text not null,               -- "RF-0025" — مولَّد أصلًا في المنصّة
  full_name     text not null,
  grade         smallint not null check (grade between 1 and 5),
  section       text not null,               -- "أ" | "ب"
  class_label   text not null,               -- "1أ" (مسرود، لتفادي إعادة الحساب في الواجهة)
  parent_name   text,
  parent_phone  text,
  notify_pref   text not null default 'sms',
  active        boolean not null default true,
  client_id     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (school_id, card_no)
);
create unique index if not exists students_client_id_key on students(client_id) where client_id is not null;
create index if not exists students_class_idx on students(school_id, class_label);

-- ---------------------------------------------------------------- الهوية
-- ملفّ الحساب: يربط مستخدم Supabase (auth.users) بدور ومؤسسة.
-- الحساب يُنشأ عبر: بطاقة/اسم مستخدم + رمز سري  (لا بريد، لا هاتف — قرار المستخدم)
create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  school_id     uuid references schools(id) on delete cascade,
  role          user_role not null,
  display_name  text not null,
  login_id      text unique,                 -- "RF-0025" للتلميذة، أو اسم مستخدم للموظّف
  student_id    uuid references students(id) on delete cascade,  -- للتلميذة: سجلّها
  phone         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists profiles_school_role_idx on profiles(school_id, role);

-- الأولياء: علاقة صريحة (جدول وصل) لا مصفوفة — تُفسح لسياسة RLS مبنية على الصفوف
create table if not exists guardians (
  profile_id  uuid not null references profiles(id) on delete cascade,
  student_id  uuid not null references students(id) on delete cascade,
  relation    text not null default 'parent',
  primary key (profile_id, student_id)
);

-- ---------------------------------------------------------------- الطواقم
create table if not exists staff (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id) on delete cascade,
  full_name   text not null,
  job_title   text not null,                 -- "معلّمة القسم" | "مديرة المؤسسة"
  class_label text,                          -- "1أ" أو "جميع الأقسام"
  profile_id  uuid references profiles(id) on delete set null,
  client_id   text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- الحضور
-- سجلّ يومي واحد لكل تلميذة (unique) + client_id لمنع ازدواج طابور المزامنة.
create table if not exists attendance (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references schools(id) on delete cascade,
  student_id   uuid not null references students(id) on delete cascade,
  day          date not null default current_date,
  state        att_state not null default 'present',
  at_time      text,                          -- "08:12"
  recorded_by  uuid references profiles(id) on delete set null,
  client_id    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (student_id, day)
);
create unique index if not exists attendance_client_id_key on attendance(client_id) where client_id is not null;
create index if not exists attendance_day_idx on attendance(school_id, day);

-- سجلّ البوابة (دخول/خروج فعلي)
create table if not exists gate_log (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id) on delete cascade,
  student_id  uuid references students(id) on delete cascade,
  at_time     text not null,
  day         date not null default current_date,
  late        boolean not null default false,
  client_id   text,
  created_at  timestamptz not null default now()
);
create unique index if not exists gate_log_client_id_key on gate_log(client_id) where client_id is not null;

-- ---------------------------------------------------------------- النقاط
-- كل صفّ = تقييم واحد ("فرض 1"، "مشاركة صفّية"، …).
-- القاعدة الفنلدية مُقنَّنة في القاعدة: kind='formative' لا يدخل في حساب المعدّل.
create table if not exists grades (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references schools(id) on delete cascade,
  student_id   uuid not null references students(id) on delete cascade,
  subject      text not null,
  term         smallint not null check (term between 1 and 3),
  label        text not null,                 -- "فرض 1"
  kind         grade_kind not null default 'summative',
  mark         numeric(4,2) not null check (mark between 0 and 10),
  recorded_by  uuid references profiles(id) on delete set null,
  client_id    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (student_id, subject, term, label)
);
create unique index if not exists grades_client_id_key on grades(client_id) where client_id is not null;
create index if not exists grades_student_idx on grades(student_id, subject, term);

-- طريقة حساب المعدّل لكل (تلميذة، مادة) — المُراكمات الشفافة الثلاثة فقط
create table if not exists gradebook_config (
  school_id    uuid not null references schools(id) on delete cascade,
  student_id   uuid not null references students(id) on delete cascade,
  subject      text not null,
  accumulator  text not null default 'avg' check (accumulator in ('avg','last','max')),
  updated_at   timestamptz not null default now(),
  primary key (student_id, subject)
);

-- ---------------------------------------------------------------- سجلّ السلوك
-- الضمانات الثلاث مفروضة هنا، لا في الواجهة:
--   متوازن   → kind ∈ {pos,neg} وإلزام التصنيف
--   اعتراض   → reply/replied_at يكتبهما صاحب الشأن؛ status لا يغيّره إلا المدير
--   محدَّد المدة → archived_at + مهمّة الأرشفة (002)
create table if not exists behaviour_notes (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references schools(id) on delete cascade,
  student_id   uuid not null references students(id) on delete cascade,
  category     text not null,                 -- إحدى الفئات الثماني المتوازنة
  kind         note_kind not null,
  body         text not null,
  subject      text,                          -- المادة عند التسجيل
  noted_on     date not null default current_date,
  status       note_status not null default 'open',
  author_id    uuid references profiles(id) on delete set null,
  author_name  text,                          -- لقطة نصّية (تبقى مفهومة بعد تغيّر الحسابات)
  reply        text,
  replied_at   timestamptz,
  archived_at  timestamptz,
  client_id    text,
  created_at   timestamptz not null default now()
);
-- ملاحظة: لا قيد جدولي هنا يربط reply بالحالة. الرابط يفرضه المشغّل
-- guard_note_update (002) باتجاه واحد صحيح: «لا اعتراض إلا على ملاحظة قائمة».
-- قيدٌ مثل (reply is null or status='open') كان سيمنع المدير من **فصل الاعتراض**
-- (إبقاء الردّ مع تحويل الحالة إلى revoked) — وهو جوهر الضمانة ②.
create unique index if not exists behaviour_notes_client_id_key on behaviour_notes(client_id) where client_id is not null;
create index if not exists behaviour_student_idx on behaviour_notes(student_id, noted_on desc);
create index if not exists behaviour_retention_idx on behaviour_notes(noted_on) where status <> 'archived';

-- ---------------------------------------------------------------- سجلّ التدقيق
-- إضافة فقط. لا سياسة UPDATE ولا DELETE ستُمنح لأي دور في 002 — بالقصد.
create table if not exists audit_log (
  id          bigserial primary key,
  school_id   uuid references schools(id) on delete cascade,
  actor_id    uuid references profiles(id) on delete set null,
  actor_name  text,
  actor_role  user_role,
  action      text not null,
  target      text,
  detail      text,
  client_id   text,                            -- منع ازدواج الأثر عند إعادة إرسال الطابور
  at          timestamptz not null default now()
);
create unique index if not exists audit_client_id_key on audit_log(client_id) where client_id is not null;
create index if not exists audit_school_at_idx on audit_log(school_id, at desc);

-- ---------------------------------------------------------------- الرسائل
create table if not exists outbox (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id) on delete cascade,
  student_id  uuid references students(id) on delete set null,
  channel     msg_channel not null,
  phone       text,
  recipient   text,                           -- اسم الولي (لقطة)
  body        text not null,
  status      msg_status not null default 'queued',
  created_by  uuid references profiles(id) on delete set null,
  client_id   text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create unique index if not exists outbox_client_id_key on outbox(client_id) where client_id is not null;
create index if not exists outbox_status_idx on outbox(school_id, status);

create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id) on delete cascade,
  student_id  uuid references students(id) on delete cascade,
  kind        text not null default 'system',
  body        text not null,
  at_time     text,
  is_read     boolean not null default false,
  client_id   text,
  created_at  timestamptz not null default now()
);
create unique index if not exists notifications_client_id_key on notifications(client_id) where client_id is not null;

-- ---------------------------------------------------------------- المنشورات
create table if not exists announcements (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id) on delete cascade,
  title       text not null,
  body        text not null,
  audience    text not null default 'all',    -- all | staff | parents | students
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  client_id   text
);
create unique index if not exists announcements_client_id_key on announcements(client_id) where client_id is not null;

create table if not exists homework (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id) on delete cascade,
  class_label text not null,
  subject     text not null,
  title       text not null,
  due_on      date,
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  client_id   text
);
create unique index if not exists homework_client_id_key on homework(client_id) where client_id is not null;

-- ---------------------------------------------------------------- الاستدعاءات والشكاوى
create table if not exists summons (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id) on delete cascade,
  student_id  uuid references students(id) on delete cascade,
  reason      text not null,
  due_on      date,
  status      text not null default 'صادرة',
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  client_id   text
);
create unique index if not exists summons_client_id_key on summons(client_id) where client_id is not null;

create table if not exists complaints (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id) on delete cascade,
  student_id  uuid references students(id) on delete set null,
  kind        text not null default 'اقتراح',
  body        text not null,
  status      text not null default 'بانتظار الرد',
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  client_id   text
);
create unique index if not exists complaints_client_id_key on complaints(client_id) where client_id is not null;

-- ---------------------------------------------------------------- التفتيش
create table if not exists inspections (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id) on delete cascade,
  purpose     text not null,
  planned_on  date,
  status      text not null default 'مبرمجة',
  inspector_id uuid references profiles(id) on delete set null,
  report      text,
  created_at  timestamptz not null default now(),
  client_id   text
);
create unique index if not exists inspections_client_id_key on inspections(client_id) where client_id is not null;

create table if not exists directives (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references schools(id) on delete cascade,
  body        text not null,
  status      text not null default 'صادرة',
  issued_by   uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  client_id   text
);
create unique index if not exists directives_client_id_key on directives(client_id) where client_id is not null;

-- ============================================================================
--  تفعيل RLS على كل جدول — منع افتراضي.
--  السياسات في sql/002_rls.sql.  بدون 002 ⇒ لا يقرأ أحد شيئًا (وهذا هو المقصود).
-- ============================================================================
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
