-- ============================================================================
--  EDUVIA — بيانات تجريبية
--  الملف: sql/003_seed_demo.sql
--
--  يُنشئ: مؤسسة واحدة + تلاميذ + طاقم + وليّ أمر.
--  لا يُنشئ **حسابات دخول** — تلك تُنشأ عبر tools/provision.mjs بالطريقة
--  الصحيحة (Admin API)، لأن كتابة كلمات السر مباشرةً في auth.users
--  ليست مدعومة رسميًا في Supabase.
--
--  يُشغَّل مرّة واحدة. آمن للإعادة (on conflict do nothing).
-- ============================================================================

do $$
declare
  v_school uuid;
  v_parent uuid;
begin
  insert into schools (name, code, wilaya)
  values ('ابتدائية النور', 'EDUVIA-NOUR', 'الجزائر')
  on conflict (code) do nothing;

  select id into v_school from schools where code = 'EDUVIA-NOUR';

  -- ------------------------------------------------------------- التلاميذ
  insert into students (school_id, card_no, full_name, grade, section, class_label, parent_name, parent_phone, notify_pref)
  values
    (v_school,'RF-0001','مريم بن علي',     1,'أ','1أ','السيد كمال بن علي',  '0551000001','sms'),
    (v_school,'RF-0002','آية بن ساسي',     1,'أ','1أ','السيد رشيد بن ساسي', '0551000002','app'),
    (v_school,'RF-0003','نور الهدى العايب',1,'أ','1أ','السيد سمير العايب',  '0551000003','sms'),
    (v_school,'RF-0004','أسماء بوجمعة',    1,'ب','1ب','السيد عمر بوجمعة',   '0551000004','sms'),
    (v_school,'RF-0005','رقية حمداني',     1,'ب','1ب','السيد خالد حمداني',  '0551000005','app'),
    (v_school,'RF-0006','جنى زروقي',       2,'أ','2أ','السيد نبيل زروقي',   '0551000006','sms'),
    (v_school,'RF-0007','ملاك بلقاسم',     2,'أ','2أ','السيد توفيق بلقاسم', '0551000007','sms'),
    (v_school,'RF-0008','سلسبيل مرابط',    3,'أ','3أ','السيد جمال مرابط',   '0551000008','app'),
    (v_school,'RF-0009','لُجين بوعلام',    4,'أ','4أ','السيد مصطفى بوعلام', '0551000009','sms'),
    (v_school,'RF-0010','رتاج سعداوي',     5,'ب','5ب','السيد الطاهر سعداوي','0551000010','sms')
  on conflict (school_id, card_no) do nothing;

  -- ------------------------------------------------------------- الطواقم
  if not exists (select 1 from staff where school_id = v_school) then
    insert into staff (school_id, full_name, job_title, class_label) values
      (v_school,'السيدة زهية','مديرة المؤسسة','الإدارة'),
      (v_school,'الأستاذة فاطمة الزهراء','معلّمة القسم','1أ'),
      (v_school,'الأستاذة نصيرة','معلّمة القسم','1ب'),
      (v_school,'الأستاذة سعاد','معلّمة القسم','2أ'),
      (v_school,'الأستاذ عبد الرحمن','التربية الإسلامية','جميع الأقسام');
  end if;

  -- ------------------------------------------------------------- نقاط وحضور
  if not exists (select 1 from grades where school_id = v_school) then
    insert into grades (school_id, student_id, subject, term, label, kind, mark)
    select v_school, s.id, subj.name, 1, subj.label, subj.kind, subj.mark
    from students s
    cross join (values
      ('اللغة العربية',  'فرض 1',       'summative'::grade_kind, 8.0::numeric),
      ('اللغة العربية',  'مشاركة صفّية','formative'::grade_kind, 9.0::numeric),
      ('الرياضيات',      'فرض 1',       'summative'::grade_kind, 7.5::numeric),
      ('الرياضيات',      'مشاركة صفّية','formative'::grade_kind, 8.5::numeric),
      ('التربية الإسلامية','فرض 1',     'summative'::grade_kind, 9.0::numeric)
    ) as subj(name, label, kind, mark)
    where s.school_id = v_school;

    insert into gradebook_config (school_id, student_id, subject, accumulator)
    select v_school, s.id, subj.name, 'avg'
    from students s
    cross join (values ('اللغة العربية'),('الرياضيات'),('التربية الإسلامية')) as subj(name)
    where s.school_id = v_school
    on conflict do nothing;
  end if;

  if not exists (select 1 from attendance where school_id = v_school) then
    insert into attendance (school_id, student_id, day, state, at_time)
    select v_school, s.id, current_date, 'present', '07:5' || (row_number() over (order by s.card_no) % 10)
    from students s where s.school_id = v_school;
  end if;

  -- ------------------------------------------------------------- سجلّ سلوك متوازن
  -- لاحظ: ٤ إيجابية و٤ سلبية — التوازن ليس تفصيلًا، بل الضمانة ①
  -- (الفئات المتاحة أصلًا ٤ إيجابية = ٤ سلبية في BEHAV_CATS بالمنصّة)
  if not exists (select 1 from behaviour_notes where school_id = v_school) then
    insert into behaviour_notes (school_id, student_id, category, kind, body, subject, noted_on, author_name)
    select v_school, s.id, x.category, x.kind::note_kind, x.body, x.subject, current_date - x.ago, x.author
    from students s
    join (values
      ('RF-0001','تحسّن ملحوظ',     'pos','تحسّنٌ ملحوظ في القراءة، أحسنتِ!','اللغة العربية','الأستاذة فاطمة الزهراء',1),
      ('RF-0001','مشاركة فعّالة',   'pos','شاركت بفاعلية في حصّة الرياضيات.','الرياضيات','الأستاذة فاطمة الزهراء',3),
      ('RF-0003','تعاون ومساعدة',   'pos','ساعدت زميلتها في فهم التمرين.','الرياضيات','الأستاذة فاطمة الزهراء',2),
      ('RF-0008','انضباط والتزام',  'pos','التزام تامّ بالنظام داخل القسم.','اللغة العربية','الأستاذة سعاد',5),
      ('RF-0002','إخلال بالهدوء',   'neg','ضجيج متكرّر أثناء الحصّة.','الرياضيات','الأستاذة فاطمة الزهراء',2),
      ('RF-0006','عدم إنجاز الواجب', 'neg','لم تُنجز واجب اللغة العربية.','اللغة العربية','الأستاذة سعاد',4),
      ('RF-0004','تأخّر متكرّر',     'neg','تأخّر عن الطابور ثلاث مرّات هذا الأسبوع.','السلوك','الأستاذة نصيرة',6),
      ('RF-0009','إهمال الأدوات',    'neg','لم تُحضر أدوات الهندسة.','الرياضيات','الأستاذة سعاد',7)
    ) as x(card, category, kind, body, subject, author, ago)
      on x.card = s.card_no
    where s.school_id = v_school;
  end if;

  -- ------------------------------------------------------------- إعلان
  if not exists (select 1 from announcements where school_id = v_school) then
    insert into announcements (school_id, title, body, audience)
    values (v_school, 'انطلاق الموسم الدراسي 2026/2027',
            'نرحّب بتلميذاتنا في الموسم الجديد. الدخول اليومي ابتداءً من الساعة 07:40.', 'all');
  end if;
end $$;

-- ---------------------------------------------------------------- تحقّق سريع
select
  (select count(*) from students)         as "التلاميذ",
  (select count(*) from staff)            as "الطواقم",
  (select count(*) from grades)           as "النقاط",
  (select count(*) from attendance)       as "سجلّات الحضور",
  (select count(*) from behaviour_notes)  as "ملاحظات السلوك",
  (select count(*) filter (where kind='pos') from behaviour_notes) as "إيجابية",
  (select count(*) filter (where kind='neg') from behaviour_notes) as "سلبية";
