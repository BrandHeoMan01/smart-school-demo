#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — اختبار صلاحيات RLS على PostgreSQL حقيقي
 *  الملف: tests/rls.test.js
 *
 *  هذا ليس فحصًا بنيويًا للنصّ — بل **تشغيل فعلي** للمخطّط والسياسات على
 *  PostgreSQL، ثم انتحال شخصية كل دور والتحقّق ممّا يراه وما يستطيع كتابته.
 *
 *  التشغيل:
 *    1) شغّل PostgreSQL  (أي نسخة 14+)
 *    2) npm i pg
 *    3) DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres node tests/rls.test.js
 *
 *  ⚠️ يستخدم قاعدة بيانات باسم eduvia_rls_test ويعيد إنشاءها — لا تشغّله
 *     على قاعدة فيها بيانات تهمّك.
 * ==========================================================================*/
"use strict";

const fs = require("fs");
const path = require("path");

let Client;
try {
  ({ Client } = require("pg"));
} catch {
  console.error("✖ مكتبة pg غير مثبّتة.  شغّل:  npm i pg");
  process.exit(2);
}

const ROOT = path.resolve(__dirname, "..");
const TEST_DB = "eduvia_rls_test";
const ADMIN_URL =
  process.env.DATABASE_URL || "postgres://postgres@127.0.0.1:5432/postgres";

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* ---------------------------------------------------------------- إحصاء */
let pass = 0;
const failures = [];
function ok(label) {
  pass++;
  console.log(`  \x1b[32m✓\x1b[0m ${label}`);
}
function bad(label, detail) {
  failures.push(label);
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ↳ ${detail}` : ""}`);
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) ok(label);
  else bad(label, `المتوقّع ${b} · الواقع ${a}`);
}
/* يتوقّع أن يُرفض الاستعلام **صراحةً** (سياسة WITH CHECK أو مشغّل أو منع عمودي).
   ملاحظة مهمّة: RLS على UPDATE/DELETE لا تُطلق خطأ عند منع صفّ — بل **تُصفّر
   عدد الصفوف المتأثّرة بصمت**. لذا نستعمل noWrite() لتلك الحالات. */
async function denied(fn, label) {
  try {
    await fn();
    bad(label, "نجح الاستعلام — وكان يجب أن يُرفض!");
  } catch (e) {
    if (e.code === "42501" || /row-level security|permission denied|غير مسموح|انقضت|سُجِّل/.test(e.message)) {
      ok(label);
    } else {
      bad(label, `رُفض لسبب آخر: ${e.code} ${e.message}`);
    }
  }
}
/* يتوقّع ألّا يقع الأثر: إمّا رفض صريح، وإمّا صفر صفوف متأثّرة.
   هذا هو المعنى الحقيقي لـ«لا يستطيع» في RLS. */
async function noWrite(fn, label) {
  try {
    const r = await fn();
    if (r && r.rowCount === 0) ok(label);
    else bad(label, `وقع الأثر فعلًا (${r ? r.rowCount : "?"} صفًّا)`);
  } catch (e) {
    if (e.code === "42501" || /row-level security|permission denied|غير مسموح|انقضت|سُجِّل/.test(e.message)) {
      ok(label);
    } else {
      bad(label, `رُفض لسبب آخر: ${e.code} ${e.message}`);
    }
  }
}
async function allowed(fn, label) {
  try {
    await fn();
    ok(label);
  } catch (e) {
    bad(label, `رُفض: ${e.code} ${e.message}`);
  }
}

/* ---------------------------------------------------------------- ثوابت */
const S = {
  school: "11111111-1111-1111-1111-111111111111",
  other: "99999999-9999-9999-9999-999999999999",
  // التلاميذ
  amina: "22222222-2222-2222-2222-222222222201",
  salma: "22222222-2222-2222-2222-222222222202",
  outsider: "22222222-2222-2222-2222-222222222203", // في مؤسسة أخرى
  // الحسابات
  uDirector: "33333333-3333-3333-3333-333333333301",
  uTeacher: "33333333-3333-3333-3333-333333333302",
  uSupervisor: "33333333-3333-3333-3333-333333333303",
  uReception: "33333333-3333-3333-3333-333333333304",
  uInspector: "33333333-3333-3333-3333-333333333305",
  uAuthority: "33333333-3333-3333-3333-333333333306",
  uAmina: "33333333-3333-3333-3333-333333333307",
  uSalma: "33333333-3333-3333-3333-333333333308",
  uParent: "33333333-3333-3333-3333-333333333309",
  uOtherSchool: "33333333-3333-3333-3333-33333333330a",
};

/* -------------------------------------------------------------- التشغيل */
async function main() {
  console.log("\n\x1b[1mEDUVIA — إثبات صلاحيات RLS على PostgreSQL\x1b[0m\n");

  // إعادة إنشاء قاعدة الاختبار من الصفر
  const boot = new Client({ connectionString: ADMIN_URL });
  await boot.connect();
  await boot.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
      where datname = $1 and pid <> pg_backend_pid()`,
    [TEST_DB]
  );
  await boot.query(`drop database if exists ${TEST_DB}`);
  await boot.query(`create database ${TEST_DB}`);
  await boot.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  const db = new Client({ connectionString: url.toString() });
  await db.connect();

  // ---------------------------------------------------------- التطبيق
  console.log("▸ تطبيق المخطّط والسياسات");
  await db.query(read("tests/supabase-shim.sql"));
  await db.query(read("sql/001_schema.sql"));
  await db.query(read("sql/002_rls.sql"));
  ok("شُغِّل shim + 001_schema + 002_rls بلا أخطاء");

  // منح صلاحيات الجداول (Supabase يمنحها افتراضيًا)
  await db.query(
    `grant select, insert, update, delete on all tables in schema public to authenticated`
  );
  await db.query(
    `grant usage, select on all sequences in schema public to authenticated`
  );
  // لكن قيد الأعمدة على profiles يجب أن يبقى نافذًا بعد المنح العام (002 فرضه)
  await db.query(read("sql/002_rls.sql").match(/revoke update on profiles[\s\S]*?to authenticated;/)[0]);

  await seed(db);
  ok("زُرعت بيانات الاختبار (مؤسستان · ٣ تلميذات · ٩ حسابات)");

  // ---------------------------------------------------------- الاختبارات
  console.log("\n▸ المصادقة والهوية");
  await testIdentity(db);
  console.log("\n▸ التلميذة: حقّ الاعتراض (الضمانة ②)");
  await testStudentReply(db);
  console.log("\n▸ التلميذة: حدود القراءة والكتابة");
  await testStudentLimits(db);
  console.log("\n▸ المعلّمة / المدير / الناظر / الأمانة");
  await testStaff(db);
  console.log("\n▸ الولي: أبناؤه فقط");
  await testParent(db);
  console.log("\n▸ المفتّش والوصاية: قراءة بلا كتابة");
  await testOverseers(db);
  console.log("\n▸ سجلّ التدقيق: إضافة فقط");
  await testAudit(db);
  console.log("\n▸ العزل بين المؤسسات");
  await testIsolation(db);
  console.log("\n▸ سياسة الاحتفاظ (١٨٠ يومًا)");
  await testRetention(db);

  await db.end();

  // ---------------------------------------------------------- الحصيلة
  console.log("\n" + "─".repeat(64));
  if (failures.length === 0) {
    console.log(`\x1b[32m\x1b[1m✅ نجحت كل الاختبارات — ${pass} تأكيدًا\x1b[0m\n`);
    process.exit(0);
  } else {
    console.log(`\x1b[31m\x1b[1m❌ ${failures.length} فشل من ${pass + failures.length}\x1b[0m`);
    failures.forEach((f) => console.log(`   · ${f}`));
    console.log();
    process.exit(1);
  }
}

/* ---------------------------------------------------------------- البذرة */
async function seed(db) {
  await db.query(
    `insert into schools (id,name,code) values
       ($1,'ابتدائية النور','EDUVIA-NOUR'),
       ($2,'ابتدائية أخرى','EDUVIA-OTHER')`,
    [S.school, S.other]
  );

  await db.query(
    `insert into students (id,school_id,card_no,full_name,grade,section,class_label,parent_name,parent_phone) values
       ($1,$4,'RF-0001','أمينة بن علي',1,'أ','1أ','السيد كمال بن علي','0551111111'),
       ($2,$4,'RF-0002','سلمى مرابط',1,'أ','1أ','السيد رشيد مرابط','0552222222'),
       ($3,$5,'RF-0003','ليلى دحماني',4,'ب','4ب','السيد عمر دحماني','0553333333')`,
    [S.amina, S.salma, S.outsider, S.school, S.other]
  );

  await db.query(
    `insert into staff (school_id,full_name,job_title,class_label) values
       ($1,'الأستاذة فاطمة الزهراء','معلّمة القسم','1أ')`,
    [S.school]
  );

  // الحسابات — تُنشأ بـ service_role (القاعدة تمنع إنشاءها من المتصفّح)
  const users = [
    [S.uDirector, "مدير"], [S.uTeacher, "معلم"], [S.uSupervisor, "ناظر"],
    [S.uReception, "أمانة"], [S.uInspector, "مفتش"], [S.uAuthority, "وصاية"],
    [S.uAmina, "تلميذة"], [S.uSalma, "تلميذة2"], [S.uParent, "ولي"],
    [S.uOtherSchool, "مدير آخر"],
  ];
  for (const [id, email] of users) {
    await db.query(`insert into auth.users (id,email) values ($1,$2)`, [id, `${email}@eduvia.local`]);
  }

  await db.query(
    `insert into profiles (id,school_id,role,display_name,login_id,student_id) values
       ($1 ,$11,'director'  ,'المديرة زهية'        ,'director' ,null),
       ($2 ,$11,'teacher'   ,'الأستاذة فاطمة الزهراء','RF-T001' ,null),
       ($3 ,$11,'supervisor','الناظر كريم'          ,'supervisor',null),
       ($4 ,$11,'reception' ,'الأمانة'              ,'reception',null),
       ($5 ,$11,'inspector' ,'المفتّش سعيد'          ,'inspector',null),
       ($6 ,$11,'authority' ,'مديرية التربية'        ,'authority',null),
       ($7 ,$11,'student'   ,'أمينة بن علي'         ,'RF-0001'  ,null),
       ($8 ,$11,'student'   ,'سلمى مرابط'           ,'RF-0002'  ,null),
       ($9 ,$11,'parent'    ,'السيد كمال بن علي'     ,'0551111111',null),
       ($10,$12,'director'  ,'مدير مؤسسة أخرى'      ,'other'    ,null)`,
    [S.uDirector, S.uTeacher, S.uSupervisor, S.uReception, S.uInspector,
     S.uAuthority, S.uAmina, S.uSalma, S.uParent, S.uOtherSchool, S.school, S.other]
  );
  // ملاحظة: student_id في profiles يشير إلى students — تصحيح الربط
  await db.query(`update profiles set student_id=$1 where id=$2`, [S.amina, S.uAmina]);
  await db.query(`update profiles set student_id=$1 where id=$2`, [S.salma, S.uSalma]);

  // الولي مرتبط بأمينة فقط
  await db.query(`insert into guardians (profile_id,student_id) values ($1,$2)`, [S.uParent, S.amina]);

  // ملاحظات سلوك: واحدة قديمة (٩ أيام) للتلميذة أمينة، وواحدة حديثة
  await db.query(
    `insert into behaviour_notes (id,school_id,student_id,category,kind,body,noted_on,status,author_name) values
       ('44444444-4444-4444-4444-444444444401',$1,$2,'إخلال بالهدوء','neg','ضجيج متكرّر أثناء الحصّة.', current_date - 2, 'open','الأستاذة فاطمة الزهراء'),
       ('44444444-4444-4444-4444-444444444402',$1,$2,'تحسّن ملحوظ'  ,'pos','تحسّنٌ ملحوظ في القراءة.'  , current_date - 9, 'open','الأستاذة فاطمة الزهراء'),
       ('44444444-4444-4444-4444-444444444403',$1,$3,'عدم إنجاز الواجب','neg','لم تُنجز الواجب.'        , current_date - 1, 'open','الأستاذة فاطمة الزهراء'),
       ('44444444-4444-4444-4444-444444444404',$1,$2,'تأخّر متكرّر'  ,'neg','تأخّر عن الطابور.'          , current_date - 200,'open','الأستاذة فاطمة الزهراء')`,
    [S.school, S.amina, S.salma]
  );

  await db.query(
    `insert into grades (school_id,student_id,subject,term,label,kind,mark) values
       ($1,$2,'الرياضيات',1,'فرض 1','summative',7.5),
       ($1,$2,'الرياضيات',1,'مشاركة صفّية','formative',9),
       ($1,$3,'الرياضيات',1,'فرض 1','summative',6)`,
    [S.school, S.amina, S.salma]
  );

  await db.query(
    `insert into attendance (school_id,student_id,day,state) values
       ($1,$2,current_date,'present'), ($1,$3,current_date,'absent')`,
    [S.school, S.amina, S.salma]
  );
}

/* ------------------------------------------------------- أدوات الانتحال */
async function as(db, userId, fn) {
  await db.query("reset role");
  await db.query("set role authenticated");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [userId]);
  try {
    return await fn();
  } finally {
    await db.query("reset role");
  }
}
const count = async (db, sql, params) => Number((await db.query(sql, params)).rows[0].n);

/* ---------------------------------------------------------------- اختبار */
async function testIdentity(db) {
  await as(db, S.uAmina, async () => {
    const r = await db.query(`select my_role() r, my_school() s, my_student_ids() ids`);
    eq(r.rows[0].r, "student", "التلميذة: دورها = student");
    eq(r.rows[0].s, S.school, "التلميذة: مؤسستها صحيحة");
    eq(r.rows[0].ids.length, 1, "التلميذة: «تلاميذها» = سجلّها وحده");
  });

  await as(db, S.uParent, async () => {
    const r = await db.query(`select my_student_ids() ids`);
    eq(r.rows[0].ids, [S.amina], "الولي: «تلاميذه» = ابنته فقط");
  });

  // محاولة تصعيد الدور — القيد العمودي يجب أن يمنعها
  await as(db, S.uAmina, async () => {
    await denied(
      () => db.query(`update profiles set role='director' where id=$1`, [S.uAmina]),
      "التلميذة لا تستطيع ترقية نفسها إلى «مدير»"
    );
  });
}

async function testStudentReply(db) {
  // ① اعتراض على ملاحظة حديثة ⇒ مسموح
  await as(db, S.uAmina, async () => {
    await allowed(
      () => db.query(
        `update behaviour_notes set reply='لم أكن أنا من أحدث الضجيج.' where id='44444444-4444-4444-4444-444444444401'`
      ),
      "التلميذة تستطيع تسجيل اعتراضها على ملاحظة حديثة"
    );
    const r = await db.query(
      `select reply, replied_at, status from behaviour_notes where id='44444444-4444-4444-4444-444444444401'`
    );
    eq(!!r.rows[0].reply, true, "نصّ الاعتراض محفوظ");
    eq(!!r.rows[0].replied_at, true, "وقت الاعتراض مُوسَم من الخادم");
    eq(r.rows[0].status, "open", "الحالة بقيت «قائمة» — التلميذة لا تُلغي ملاحظة");
  });

  await as(db, S.uAmina, async () => {
    // ② لا تستطيع تغيير الحالة (إلغاء العقوبة بنفسها)
    await denied(
      () => db.query(`update behaviour_notes set status='revoked' where id='44444444-4444-4444-4444-444444444401'`),
      "التلميذة لا تستطيع تغيير حالة الملاحظة (لا تُلغيها بنفسها)"
    );
    // ③ لا تستطيع تغيير نصّ الملاحظة الأصلية
    await denied(
      () => db.query(`update behaviour_notes set body='نصّ آخر' where id='44444444-4444-4444-4444-444444444401'`),
      "التلميذة لا تستطيع تعديل نصّ الملاحظة الأصلية"
    );
    // ④ لا تستطيع تعديل تصنيفها (pos↔neg)
    await denied(
      () => db.query(`update behaviour_notes set kind='pos' where id='44444444-4444-4444-4444-444444444401'`),
      "التلميذة لا تستطيع قلب التصنيف (سلبي ← إيجابي)"
    );
    // ⑤ اعتراض ثانٍ ⇒ مرفوض
    await denied(
      () => db.query(`update behaviour_notes set reply='اعتراض آخر' where id='44444444-4444-4444-4444-444444444401'`),
      "لا يُقبل اعتراض ثانٍ على الملاحظة نفسها"
    );
    // ⑥ بعد انقضاء المهلة (٩ أيام) ⇒ مرفوض
    await denied(
      () => db.query(`update behaviour_notes set reply='اعتراض متأخّر' where id='44444444-4444-4444-4444-444444444402'`),
      "لا يُقبل الاعتراض بعد انقضاء مهلة ٧ أيام"
    );
    // ⑦ لا تستطيع الاعتراض على ملاحظة تلميذة أخرى
    const n = await count(db,
      `select count(*)::int n from behaviour_notes where id='44444444-4444-4444-4444-444444444403'`);
    eq(n, 0, "التلميذة لا ترى ملاحظات تلميذة أخرى (فلا تعترض عليها)");
  });
}

async function testStudentLimits(db) {
  await as(db, S.uAmina, async () => {
    eq(await count(db, `select count(*)::int n from grades`), 2,
       "التلميذة ترى نقاطها فقط (تحصيلي + تكويني · لا نقاط زميلتها)");
    eq(await count(db, `select count(*)::int n from attendance`), 1,
       "التلميذة ترى حضورها فقط");
    eq(await count(db, `select count(*)::int n from students`), 1,
       "التلميذة ترى سجلّها فقط من قائمة التلاميذ");
    eq(await count(db, `select count(*)::int n from behaviour_notes`), 3,
       "التلميذة ترى ملاحظاتها الثلاث (منها المؤرشفة-المؤهّلة)");

    await denied(
      () => db.query(`insert into grades (school_id,student_id,subject,term,label,kind,mark)
                      values ($1,$2,'الرياضيات',1,'فرض 9','summative',10)`, [S.school, S.amina]),
      "التلميذة لا تستطيع كتابة نقاطها"
    );
    await denied(
      () => db.query(`insert into behaviour_notes (school_id,student_id,category,kind,body)
                      values ($1,$2,'تحسّن ملحوظ','pos','ملاحظة على نفسي')`, [S.school, S.amina]),
      "التلميذة لا تستطيع إنشاء ملاحظة سلوك لنفسها"
    );
  });

  // الولي: قراءة بلا كتابة
  await as(db, S.uParent, async () => {
    eq(await count(db, `select count(*)::int n from behaviour_notes`), 3, "الولي يرى ملاحظات ابنته");
    await denied(
      () => db.query(`insert into grades (school_id,student_id,subject,term,label,kind,mark)
                      values ($1,$2,'الرياضيات',2,'فرض 1','summative',5)`, [S.school, S.amina]),
      "الولي لا يكتب النقاط"
    );
  });
}

async function testStaff(db) {
  await as(db, S.uTeacher, async () => {
    eq(await count(db, `select count(*)::int n from students`), 2,
       "المعلّمة ترى تلميذات مؤسستها (٢) لا تلميذة المؤسسة الأخرى");
    await allowed(
      () => db.query(`insert into attendance (school_id,student_id,day,state,client_id)
                      values ($1,$2,current_date,'late',$3)
                      on conflict (student_id,day) do update set state='late', client_id=excluded.client_id`,
                     [S.school, S.amina, "cid-att-1"]),
      "المعلّمة تسجّل الحضور (وبتكرار آمن: on conflict — جوهر إعادة إرسال الطابور)"
    );
    await allowed(
      () => db.query(`insert into behaviour_notes (school_id,student_id,category,kind,body,author_name)
                      values ($1,$2,'تعاون ومساعدة','pos','ساعدت زميلتها.',$3)`,
                     [S.school, S.amina, "الأستاذة فاطمة الزهراء"]),
      "المعلّمة تُسجّل ملاحظة سلوك إيجابية"
    );
    await noWrite(
      () => db.query(`delete from students where id=$1`, [S.amina]),
      "المعلّمة لا تستطيع حذف تلميذة"
    );
    await denied(
      () => db.query(`insert into students (school_id,card_no,full_name,grade,section,class_label)
                      values ($1,'RF-9999','تلميذة جديدة',1,'أ','1أ')`, [S.school]),
      "المعلّمة لا تستطيع تسجيل تلميذة جديدة (من عمل الأمانة)"
    );
  });

  await as(db, S.uDirector, async () => {
    await allowed(
      () => db.query(`update behaviour_notes set status='revoked' where id='44444444-4444-4444-4444-444444444401'`),
      "المدير يُلغي ملاحظة بعد الاعتراض (فصل الاعتراض)"
    );
    const r = await db.query(`select status from behaviour_notes where id='44444444-4444-4444-4444-444444444401'`);
    eq(r.rows[0].status, "revoked", "الإلغاء نافذ فعلًا");
    eq(await count(db, `select count(*)::int n from students`), 2, "المدير يرى تلاميذ مؤسسته");
  });

  await as(db, S.uSupervisor, async () => {
    await allowed(
      () => db.query(`insert into summons (school_id,student_id,reason) values ($1,$2,'تأخّر متكرّر')`,
                     [S.school, S.amina]),
      "الناظر يُصدر استدعاء"
    );
    await allowed(
      () => db.query(`update behaviour_notes set status='open' where id='44444444-4444-4444-4444-444444444401'`),
      "الناظر يثبّت ملاحظة بعد المراجعة"
    );
  });

  await as(db, S.uReception, async () => {
    await allowed(
      () => db.query(`insert into students (school_id,card_no,full_name,grade,section,class_label)
                      values ($1,'RF-0031','جنى حمداني',2,'ب','2ب')`, [S.school]),
      "الأمانة تُسجّل تلميذة جديدة"
    );
    await denied(
      () => db.query(`insert into grades (school_id,student_id,subject,term,label,kind,mark)
                      values ($1,$2,'الرياضيات',1,'فرض 3','summative',8)`, [S.school, S.amina]),
      "الأمانة لا تكتب النقاط"
    );
  });
}

async function testParent(db) {
  await as(db, S.uParent, async () => {
    eq(await count(db, `select count(*)::int n from students`), 1,
       "الولي يرى سجلّ ابنته فقط");
    eq(await count(db, `select count(*)::int n from grades`), 2,
       "الولي يرى نقاط ابنته (تحصيلي + تكويني)");
    await denied(
      () => db.query(`update behaviour_notes set status='revoked' where id='44444444-4444-4444-4444-444444444402'`),
      "الولي لا يُلغي ملاحظة بنفسه"
    );
  });
}

async function testOverseers(db) {
  // العدد المرجعي يُقرأ بصلاحية الخادم (خارج RLS) ليبقى الاختبار مستقلًّا عن ترتيب ما سبقه
  const total = await count(db, `select count(*)::int n from students where school_id=$1`, [S.school]);
  for (const [uid, label] of [[S.uInspector, "المفتّش"], [S.uAuthority, "الوصاية"]]) {
    await as(db, uid, async () => {
      eq(await count(db, `select count(*)::int n from students`), total,
         `${label} يقرأ تلاميذ مؤسسته (${total})`);
      await denied(
        () => db.query(`insert into grades (school_id,student_id,subject,term,label,kind,mark)
                        values ($1,$2,'الرياضيات',2,'فرض 1','summative',9)`, [S.school, S.amina]),
        `${label} لا يكتب النقاط (قراءة فقط)`
      );
      await noWrite(
        () => db.query(`update students set full_name='تغيير' where id=$1`, [S.amina]),
        `${label} لا يعدّل سجلّ تلميذة`
      );
    });
  }
}

async function testAudit(db) {
  await as(db, S.uTeacher, async () => {
    await allowed(
      () => db.query(`insert into audit_log (action,target,detail)
                      values ('عرض كشف النقاط','التلميذة أمينة','الفصل الأول')`),
      "المعلّمة تكتب في سجلّ التدقيق"
    );
  });
  // الأثر يجب أن يُوسَم من الخادم لا من العميل
  const r = await db.query(`select actor_id, actor_role, school_id from audit_log order by id desc limit 1`);
  eq(r.rows[0].actor_id, S.uTeacher, "الفاعل مُوسَم من الخادم (لا يمكن انتحال غيره)");
  eq(r.rows[0].actor_role, "teacher", "دور الفاعل مُوسَم من الخادم");

  await as(db, S.uDirector, async () => {
    const c = await count(db, `select count(*)::int n from audit_log`);
    eq(c >= 1, true, "المدير يقرأ سجلّ التدقيق");
    await noWrite(
      () => db.query(`update audit_log set action='مُحوَّل' where id=(select max(id) from audit_log)`),
      "لا أحد يستطيع تعديل سجلّ التدقيق (لا سياسة UPDATE إطلاقًا)"
    );
    await noWrite(
      () => db.query(`delete from audit_log where id=(select max(id) from audit_log)`),
      "لا أحد يستطيع حذف سجلّ التدقيق (لا سياسة DELETE إطلاقًا)"
    );
  });

  await as(db, S.uTeacher, async () => {
    eq(await count(db, `select count(*)::int n from audit_log`), 1,
       "المعلّمة ترى أثرها هي فقط (لا أثر غيرها)");
  });
}

async function testIsolation(db) {
  await as(db, S.uOtherSchool, async () => {
    eq(await count(db, `select count(*)::int n from students`), 1,
       "مدير مؤسسة أخرى يرى تلميذته وحدها");
    eq(await count(db, `select count(*)::int n from behaviour_notes`), 0,
       "مدير مؤسسة أخرى لا يرى أيّ ملاحظة سلوك من مؤسسة النور");
    eq(await count(db, `select count(*)::int n from audit_log`), 0,
       "مدير مؤسسة أخرى لا يرى سجلّ تدقيق النور");
  });
}

async function testRetention(db) {
  const n = await db.query(`select public.archive_expired_notes() n`);
  eq(Number(n.rows[0].n), 1, "أُرشفت ملاحظة واحدة تجاوزت ١٨٠ يومًا");
  const r = await db.query(
    `select status, archived_at from behaviour_notes where id='44444444-4444-4444-4444-444444444404'`
  );
  eq(r.rows[0].status, "archived", "الملاحظة القديمة صارت «مؤرشفة»");
  eq(!!r.rows[0].archived_at, true, "تاريخ الأرشفة مُوسَم");

  // التلميذة لا تستطيع الاعتراض على ملاحظة مؤرشفة
  await as(db, S.uAmina, async () => {
    await denied(
      () => db.query(`update behaviour_notes set reply='اعتراض متأخّر جدًا'
                      where id='44444444-4444-4444-4444-444444444404'`),
      "لا اعتراض على ملاحظة مؤرشفة"
    );
  });
}

main().catch((e) => {
  console.error("\n\x1b[31m✖ فشل التشغيل:\x1b[0m", e.message);
  process.exit(1);
});
