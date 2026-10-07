-- ============================================================================
--  EDUVIA — اختبار ذاتي للصلاحيات داخل Supabase
--  الملف: sql/verify.sql
--
--  الصق هذا الملف كاملًا في محرّر SQL في Supabase واضغط Run.
--  سيطبع جدولًا يقول لك — لكل دور — ما نجح وما فشل.
--
--  لماذا نحتاج هذا؟ محرّر SQL في Supabase يعمل بصلاحية `postgres`، وهي
--  **تتجاوز RLS**. فلو جرّبت هنا مباشرةً لظننت أن كل شيء مفتوح. لذا ننتحل
--  شخصية كل دور فعلًا (set local role + JWT claim) ثم نختبر.
--
--  المتطلّب: أن تكون حسابات الدخول قد أُنشئت عبر tools/provision.mjs.
--  إن لم تكن موجودة، تُتخطّى الاختبارات وتُطبع ملاحظة.
-- ============================================================================

drop table if exists _eduvia_verify;
create temp table _eduvia_verify (n int generated always as identity, check_name text, result text);

do $$
declare
  v_dir  uuid;  v_tea  uuid;  v_stu  uuid;  v_par  uuid;
  v_student uuid; v_note uuid; v_note_old uuid;
  v_cnt int; v_rows int;
  v_blocked boolean;
begin
  -- ------------------------------------------------------------ الحسابات
  select id into v_dir from profiles where role='director'  limit 1;
  select id into v_tea from profiles where role='teacher'   limit 1;
  select id into v_stu from profiles where role='student'   limit 1;
  select id into v_par from profiles where role='parent'    limit 1;
  select student_id into v_student from profiles where id = v_stu;

  if v_dir is null then
    insert into _eduvia_verify (check_name, result)
    values ('حسابات الدخول', '⚠️ لا توجد حسابات — شغّل tools/provision.mjs ثم أعد المحاولة');
    return;
  end if;

  insert into _eduvia_verify (check_name, result)
  values ('حسابات الدخول', '✓ موجودة (مدير/معلم/تلميذ/ولي)');

  -- ============================ ① RLS مُفعَّل على كل الجداول
  select count(*) into v_cnt
    from pg_tables
   where schemaname='public' and not rowsecurity;
  insert into _eduvia_verify values (
    'RLS مُفعَّل على كل جداول public',
    case when v_cnt = 0 then '✓ نعم (0 جدول مكشوف)' else '✗ ' || v_cnt || ' جدول بلا RLS!' end);

  -- ============================ ② لا سياسة UPDATE/DELETE على سجلّ التدقيق
  select count(*) into v_cnt
    from pg_policies
   where schemaname='public' and tablename='audit_log'
     and cmd in ('UPDATE','DELETE','ALL');
  insert into _eduvia_verify values (
    'سجلّ التدقيق: لا سياسة تعديل/حذف',
    case when v_cnt = 0 then '✓ لا توجد (إضافة فقط)' else '✗ وُجدت ' || v_cnt || ' سياسة!' end);

  -- ============================ ③ التحقّق من الصلاحيات بالانتحال الفعلي
  if v_stu is not null and v_student is not null then

    -- (أ) التلميذة ترى سجلّها وحده
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_stu::text, true);
      execute 'select count(*) from students' into v_cnt;
      reset role;
      insert into _eduvia_verify values (
        'التلميذة ترى سجلّها فقط',
        case when v_cnt = 1 then '✓ صفّ واحد' else '✗ ترى ' || v_cnt || ' صفًّا' end);
    exception when others then
      reset role;
      insert into _eduvia_verify values ('التلميذة ترى سجلّها فقط', '✗ خطأ: ' || sqlerrm);
    end;

    -- (ب) التلميذة لا تستطيع تغيير حالة ملاحظة سلوك
    select id, noted_on into v_note, v_note_old
      from behaviour_notes
     where student_id = v_student and status='open'
       and noted_on >= current_date - 7
     limit 1;

    if v_note is not null then
      v_blocked := false;
      begin
        execute 'set local role authenticated';
        perform set_config('request.jwt.claim.sub', v_stu::text, true);
        execute format('update behaviour_notes set status=''revoked'' where id = %L', v_note);
        reset role;
      exception when others then
        reset role;
        v_blocked := true;
      end;
      insert into _eduvia_verify values (
        'التلميذة لا تُلغي ملاحظة على نفسها',
        case when v_blocked then '✓ مرفوض (كما يجب)' else '✗ نجحت — ثغرة خطيرة!' end);

      -- (ج) لكنها تستطيع الاعتراض
      begin
        execute 'set local role authenticated';
        perform set_config('request.jwt.claim.sub', v_stu::text, true);
        execute format('update behaviour_notes set reply=''اعتراض تجريبي'' where id = %L', v_note);
        reset role;
        insert into _eduvia_verify values ('التلميذة تستطيع تسجيل اعتراضها', '✓ مسموح (حقّها)');
      exception when others then
        reset role;
        insert into _eduvia_verify values ('التلميذة تستطيع تسجيل اعتراضها', '✗ مرفوض: ' || sqlerrm);
      end;
    else
      insert into _eduvia_verify values ('اختبار الاعتراض', '⚠️ لا ملاحظة حديثة للمحاولة عليها');
    end if;

    -- (د) التلميذة لا تكتب نقاطًا
    v_blocked := false;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_stu::text, true);
      execute format('insert into grades (school_id,student_id,subject,term,label,kind,mark)
                      select school_id, id, ''اختبار'', 3, ''تسلّل'', ''summative'', 10
                        from students where id = %L', v_student);
      reset role;
    exception when others then
      reset role; v_blocked := true;
    end;
    insert into _eduvia_verify values (
      'التلميذة لا تكتب نقاطها',
      case when v_blocked then '✓ مرفوض' else '✗ نجحت — ثغرة!' end);

    -- (هـ) التلميذة لا تُرقّي نفسها إلى مدير
    v_blocked := false;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_stu::text, true);
      execute format('update profiles set role=''director'' where id = %L', v_stu);
      reset role;
    exception when others then
      reset role; v_blocked := true;
    end;
    insert into _eduvia_verify values (
      'التلميذة لا تُرقّي نفسها إلى مدير',
      case when v_blocked then '✓ مرفوض (القيد العمودي يعمل)' else '✗ نجحت — تصعيد صلاحيات!' end);
  end if;

  -- ============================ ④ المعلّمة تكتب، ولا تحذف
  if v_tea is not null then
    v_blocked := false;
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', v_tea::text, true);
      execute 'delete from students where id = (select id from students limit 1)';
      get diagnostics v_rows = row_count;
      reset role;
      v_blocked := (v_rows = 0);
    exception when others then
      reset role; v_blocked := true;
    end;
    insert into _eduvia_verify values (
      'المعلّمة لا تحذف تلميذة',
      case when v_blocked then '✓ لا أثر' else '✗ حذفت فعلًا — ثغرة!' end);
  end if;

  -- ============================ ⑤ سياسة الاحتفاظ تعمل
  begin
    select public.archive_expired_notes() into v_cnt;
    insert into _eduvia_verify values ('دالة الأرشفة (١٨٠ يومًا) تعمل', '✓ أُرشف ' || v_cnt || ' ملاحظة');
  exception when others then
    insert into _eduvia_verify values ('دالة الأرشفة (١٨٠ يومًا) تعمل', '✗ خطأ: ' || sqlerrm);
  end;

  -- ============================ ⑥ pg_cron مجدول
  begin
    select count(*) into v_cnt from cron.job where jobname = 'eduvia-archive-behaviour';
    insert into _eduvia_verify values (
      'الأرشفة مجدولة تلقائيًا (pg_cron)',
      case when v_cnt > 0 then '✓ مجدولة يوميًا' else '⚠️ غير مجدولة — شغّل الدالة يدويًا دوريًا' end);
  exception when others then
    insert into _eduvia_verify values ('الأرشفة مجدولة تلقائيًا (pg_cron)', '⚠️ pg_cron غير متوفّر');
  end;
end $$;

select
  case
    when result like '✓%' then '✅ ' || check_name
    when result like '✗%' then '❌ ' || check_name
    else '⚠️ ' || check_name
  end as "الاختبار",
  result as "النتيجة"
from _eduvia_verify order by n;
