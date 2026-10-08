#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — إثبات حيّ: هل الجلب (hydration) يعمل فعلًا على الخادم؟
 *  الملف: tools/verify-live.mjs
 *
 *  يجيب سؤالًا واحدًا: **ماذا ترى كل مستخدمة عند دخولها؟**
 *  يُحاكي ما تفعله hydrate() بالضبط: نفس الجداول، نفس الأعمدة، نفس الأدوار.
 *  الاختبارات المحلية تشغّل hydrate() بخادم وهمي؛ هذا يتحقّق من **الخادم نفسه**:
 *  مشروع Supabase حقيقي، RLS حقيقية، بيانات حقيقية.
 *
 *  الاستعمال:
 *    node tools/verify-live.mjs            # يقرأ الإعداد من index.html و roster.csv
 *    node tools/verify-live.mjs --keep     # لا يُعيد الملاحظات إلى حالتها
 *
 *  ⚠️ يعدّل بيانات المدرسة التجريبية (اعتراض ثم إلغاء ثم إعادة). بلا --keep
 *     يعيدها كما كانت في النهاية. شغّله على مشروع تجريبي لأنّ هذا مقصوده.
 *
 *  الأرقام السرّية تُقرأ من roster.csv (مُستثنى من Git) — لا تُكتب في الكود.
 * ==========================================================================*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.argv.includes("--keep");

/* ------------------------------------------------ الإعداد من index.html */
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const grab = (k) => {
  const m = new RegExp(`${k}\\s*:\\s*"([^"]+)"`).exec(html);
  return m ? m[1] : null;
};
const URL_ = grab("supabaseUrl");
const KEY = grab("supabaseAnonKey");
if (!URL_ || !KEY) {
  console.error("✖ لم أجد supabaseUrl/supabaseAnonKey في EDUVIA_CONFIG داخل index.html.");
  console.error("  المنصّة في الوضع المحلي — لا خادم لتُختبر عليه.");
  process.exit(2);
}

/* ------------------------------------------------ الكشف (roster.csv) */
const ROSTER = path.join(ROOT, "roster.csv");
if (!fs.existsSync(ROSTER)) {
  console.error("✖ لا يوجد roster.csv — شغّل أولًا: node tools/provision.mjs");
  console.error("  (الملف مُستثنى من Git لأنّه يحمل الأرقام السرّية.)");
  process.exit(2);
}
/* الأسطر: "النوع","المُعرِّف","الاسم","القسم","الرمز السري" (BOM في أوله) */
const rows = fs.readFileSync(ROSTER, "utf8").replace(/^﻿/, "")
  .split(/\r?\n/).slice(1).filter((l) => l.trim())
  .map((l) => (l.match(/"[^"]*"/g) || []).map((c) => c.slice(1, -1)))
  .filter((c) => c.length >= 5);

const student = rows.find((c) => c[0] === "تلميذة");
const student2 = rows.filter((c) => c[0] === "تلميذة" && c[1] !== student?.[1])[0] || null;
const director = rows.find((c) => c[1] === "director");
const teacher = rows.find((c) => c[0] === "طاقم" && c[3] === "teacher");
if (!student || !director) {
  console.error("✖ لم أجد تلميذة ومديرًا في roster.csv — أعد تشغيل provision.mjs.");
  process.exit(2);
}

/* ------------------------------------------------ الإحصاء */
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const no = (m, d) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ↳ ${d}` : ""}`); };
const chk = (c, m, d) => (c ? ok(m) : no(m, d));

const H = (t) => ({ apikey: KEY, Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

async function login(id, pin) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${id.toLowerCase()}@eduvia.local`, password: pin }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${id}: ${j.error_description || j.msg || r.status}`);
  return j.access_token;
}
const get = async (t, q, tok) => {
  const r = await fetch(`${URL_}/rest/v1/${t}?${q}`, { headers: H(tok) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const patch = async (t, q, row, tok) => {
  const r = await fetch(`${URL_}/rest/v1/${t}?${q}`, {
    method: "PATCH", headers: { ...H(tok), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = async (t, row, tok) => {
  const r = await fetch(`${URL_}/rest/v1/${t}`, {
    method: "POST", headers: { ...H(tok), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
/* مُعرِّف الحساب (auth.uid) — القاعدة تشترط created_by، والعميل يرسله من جلسته. */
const whoami = async (tok) => {
  const r = await fetch(`${URL_}/auth/v1/user`, { headers: H(tok) });
  const j = await r.json().catch(() => null);
  return j ? j.id : null;
};

/* ============================================================ التشغيل */
(async () => {
  console.log("\n\x1b[1mEDUVIA — إثبات الجلب على الخادم الحقيقي\x1b[0m");
  console.log(`\x1b[2m${URL_}  ·  ${student[1]} و ${director[1]}\x1b[0m\n`);

  const stu = await login(student[1], student[4]);
  const dir = await login(director[1], director[4]);
  const tea = teacher ? await login(teacher[1], teacher[4]) : null;
  ok(`دخول ${student[1]} و${director[1]}${teacher ? " و" + teacher[1] : ""} — كلّهم نالوا جلسة`);

  /* اختبار سابق قد يترك اعتراضًا معلّقًا. نبدأ من حالة نظيفة، وإلّا قاس
     الإثباتُ أثرًا قديمًا لا سلوكًا حاليًّا. */
  if (!KEEP) {
    const r = await patch("behaviour_notes", "id=not.is.null",
      { status: "open", reply: null, replied_at: null }, dir);
    ok(`أُعيدت الملاحظات التجريبية إلى حالتها الأصلية (${(r.body || []).length} صفّ)`);
  }

  /* ---------- ① ما يراه كل دور: جوهر «المدرسة موجودة» ---------- */
  console.log("\n▸ ① عدد الصفوف المرئية — RLS هي المرشّح لا الواجهة");
  const s1 = await get("students",
    "select=id,card_no,full_name,class_label,parent_name,parent_phone,notify_pref,grade,section", stu);
  const s2 = await get("students", "select=id,card_no,full_name", dir);
  chk(s1.status === 200 && s1.body.length === 1, "التلميذة ترى صفًّا واحدًا فقط",
      JSON.stringify(s1.body).slice(0, 120));
  chk(s1.body[0]?.card_no === student[1], "وهو صفّها هي");
  chk(s2.status === 200 && s2.body.length > 1, `المديرة ترى المدرسة كاملة (${s2.body.length})`,
      "رأت " + s2.body.length);
  chk(s1.body[0] && "parent_name" in s1.body[0] && "notify_pref" in s1.body[0],
      "كل الأعمدة التي تحتاجها الواجهة حاضرة (الوليّ · الهاتف · التفضيل)");

  /* ---------- ② سجلّ السلوك ---------- */
  console.log("\n▸ ② سجلّ السلوك — الحالة تُشتقّ من reply لا تُخمَّن");
  const n1 = await get("behaviour_notes",
    "select=id,student_id,category,kind,body,subject,noted_on,author_name,reply,replied_at,status,client_id&order=noted_on.desc", stu);
  chk(n1.status === 200 && n1.body.length >= 1, `التلميذة ترى ملاحظاتها (${(n1.body || []).length})`);
  const open = (n1.body || []).find((n) => n.status === "open" && !n.reply);
  chk(!!open, "توجد ملاحظة «قائم» بلا اعتراض ⇒ تُعرض «قائم» لا «قيد النظر»");
  const nd = await get("behaviour_notes", "select=id&limit=1000", dir);
  chk(nd.body.length >= 8, `المديرة ترى ملاحظات المدرسة (${nd.body.length})`);
  if (!open) {
    console.log("\n\x1b[33m⚠️ لا ملاحظة مفتوحة بلا اعتراض — تُخطّى اختبارات الاعتراض.\x1b[0m");
  }

  /* ---------- ③ النقاط والحضور ---------- */
  console.log("\n▸ ③ النقاط والحضور — ما يُبنى منه دفتر النقاط");
  const g = await get("grades", "select=id,student_id,subject,label,kind,mark", stu);
  chk(g.status === 200 && g.body.length >= 1, `نقاط التلميذة تصل (${g.body.length})`);
  chk(g.body.every((x) => ["summative", "formative"].includes(x.kind)),
      "كل صفّ يحمل نوعه (summative/formative)");
  const a = await get("attendance", "select=student_id,day,state,at_time", stu);
  chk(a.status === 200 && a.body.length >= 1, `سجلّ الحضور يصل (${a.body.length})`);

  /* ---------- ④ الاعتراض: تعديل الصفّ نفسه ---------- */
  if (open) {
    console.log("\n▸ ④ الاعتراض — تعديل الصفّ نفسه لا إنشاء نسخة ثانية");
    const before = n1.body.length;
    const TEXT = "إثبات آلي: هذا اعتراض";
    const obj = await patch("behaviour_notes", "id=eq." + open.id,
      { reply: TEXT, replied_at: new Date().toISOString() }, stu);
    chk(obj.status === 200 && Array.isArray(obj.body) && obj.body.length === 1,
        "التلميذة كتبت اعتراضها ⇒ صفّ واحد تأثّر",
        `HTTP ${obj.status} · ${JSON.stringify(obj.body).slice(0, 140)}`);
    const after = await get("behaviour_notes", "select=id", stu);
    chk(after.body.length === before, "عدد الملاحظات لم يزد ⇒ لم تُنشأ نسخة ثانية");

    /* جوهر الشكوى المُبلَّغ عنها: هل يُدرَج الاعتراض في قائمة المديرة؟
       هذا **نفس الاستعلام** الذي يبنيه الآن قسم «اعتراضات على ملاحظات السلوك». */
    const objs = await get("behaviour_notes", "select=id&status=eq.open&reply=not.is.null", dir);
    chk((objs.body || []).some((x) => x.id === open.id),
        "الاعتراض يظهر في قائمة المديرة («قيد النظر») — وهو ما كان يبدو مفقودًا",
        JSON.stringify(objs.body).slice(0, 120));

    /* ---------- ⑤ الحدّ: لا تمسّ الحالة ---------- */
    console.log("\n▸ ⑤ الحدّ — التلميذة لا تمسّ الحالة");
    const bad = await patch("behaviour_notes", "id=eq." + open.id, { status: "revoked" }, stu);
    chk(bad.status >= 400, "محاولة إلغاء ملاحظة على نفسها ⇒ مرفوضة",
        `HTTP ${bad.status} · ${JSON.stringify(bad.body).slice(0, 120)}`);
    if (tea) {
      const tbad = await patch("behaviour_notes", "id=eq." + open.id, { status: "revoked" }, tea);
      chk(tbad.status >= 400 || (tbad.body || []).length === 0,
          "المعلّمة كذلك لا تُلغي (الحالة للمديرة وحدها)");
    }

    /* ---------- ⑥ المديرة تحسم ---------- */
    console.log("\n▸ ⑥ المديرة ترى الاعتراض وتحسمه");
    const seen = await get("behaviour_notes", "select=id,reply&id=eq." + open.id, dir);
    chk(seen.body[0]?.reply === TEXT, "المديرة ترى نصّ الاعتراض");
    const rev = await patch("behaviour_notes", "id=eq." + open.id, { status: "revoked" }, dir);
    chk(rev.status === 200 && rev.body.length === 1, "المديرة ألغت الملاحظة ⇒ صفّ واحد");

    /* ---------- ⑦ إعادة الحالة ---------- */
    if (!KEEP) {
      const back = await patch("behaviour_notes", "id=eq." + open.id,
        { status: "open", reply: null, replied_at: null }, dir);
      chk(back.status === 200 && back.body.length === 1,
          "أُعيدت الملاحظة إلى حالتها الأصلية (البيانات التجريبية نظيفة)");
    }
  }

  /* ---------- ⑧ الطابور: كتابة جديدة تصل فعلًا ---------- */
  console.log("\n▸ ⑧ الكتابة من الطابور — نفس ما يفعله flushQueue بـupsert");
  const cid = "verify-" + Date.now().toString(36);
  const ins = await fetch(`${URL_}/rest/v1/audit_log`, {
    method: "POST", headers: { ...H(dir), Prefer: "return=representation" },
    body: JSON.stringify({ action: "إثبات آلي", target: "tools/verify-live.mjs", detail: cid, client_id: cid }),
  });
  const insBody = await ins.json().catch(() => null);
  chk(ins.status === 201 && insBody?.length === 1, "أثر جديد وصل سجلّ التدقيق");
  chk(insBody?.[0]?.actor_id != null, "الخادم وسم الفاعل بنفسه (لا يرسله العميل)");
  /* إعادة الإرسال نفسه: الفهرس الفريد على client_id ⇒ ازدواج 409 لا صفّ ثانٍ. */
  const dup = await fetch(`${URL_}/rest/v1/audit_log`, {
    method: "POST", headers: { ...H(dir), Prefer: "return=representation" },
    body: JSON.stringify({ action: "إثبات آلي", target: "tools/verify-live.mjs", detail: cid, client_id: cid }),
  });
  chk(dup.status === 409 || dup.status === 400,
      "إعادة إرسال الصفّ نفسه ⇒ يرفضه الخادم (منع الازدواج يعمل)",
      "HTTP " + dup.status);
  if (!KEEP) {
    await fetch(`${URL_}/rest/v1/audit_log?client_id=eq.${encodeURIComponent(cid)}`,
      { method: "DELETE", headers: H(dir) });
  }

  /* ---------- ⑨ صندوق الشكاوى: كان لا يغادر الجهاز أبدًا ---------- */
  console.log("\n▸ ⑨ صندوق الشكاوى — صفٌّ كما يبنيه rowFor بالضبط");
  const tag = "verify-" + Date.now().toString(36);
  const stuUid = await whoami(stu);
  /* ملاحظة: `target`/`anonymous` عمودان في sql/006. لم يُشغَّل بعد هنا،
     فالعميل **يُدرج الهدف في المتن** بدل إرسال عمود يرفضه الخادم. */
  const cbody = "«النظافة»: أثر إثبات آلي " + tag;
  const c1 = await post("complaints",
    { kind: "شكوى", body: cbody, status: "مُرسَل", created_by: stuUid, client_id: tag }, stu);
  chk(c1.status === 201 && c1.body?.length === 1,
      "التلميذة أرسلت شكوى ⇒ وصلت القاعدة",
      `HTTP ${c1.status} · ${JSON.stringify(c1.body).slice(0, 140)}`);
  const rowId = c1.body?.[0]?.id;
  chk(c1.body?.[0]?.created_by === stuUid, "الخادم يربطها بصاحبتها (created_by)");

  const cdup = await post("complaints",
    { kind: "شكوى", body: cbody, status: "مُرسَل", created_by: stuUid, client_id: tag }, stu);
  chk(cdup.status === 409 || cdup.status === 400,
      "إعادة الإرسال ⇒ منع الازدواج (لا شكوى مكرّرة)", "HTTP " + cdup.status);

  const cDir = await get("complaints", "select=id,kind,body,status,created_by&client_id=eq." + tag, dir);
  chk(cDir.body?.length === 1, "المديرة ترى الشكوى — وهذا كان مستحيلًا قبل اليوم");
  if (student2) {
    const stu2 = await login(student2[1], student2[4]);
    const cS2 = await get("complaints", "select=id&client_id=eq." + tag, stu2);
    chk(cS2.body?.length === 0, "والتلميذة الأخرى لا ترى شكوى زميلتها");
  }
  const cUp = await patch("complaints", "id=eq." + rowId, { status: "تمّت المعالجة" }, dir);
  chk(cUp.status === 200 && cUp.body?.length === 1, "المديرة حدّثت حالة الطلب ⇒ صفّ واحد");
  if (rowId) {
    const seen = await get("complaints", "select=status&id=eq." + rowId, stu);
    chk(seen.body?.[0]?.status === "تمّت المعالجة",
        "والتلميذة ترى قرار الإدارة (كانت ترى «مُرسَل» أبدًا)");
  }
  if (!KEEP && rowId) {
    /* لا سياسة DELETE للشكاوى — فنبقي الأثر موسومًا بدل أن ندّعي التنظيف. */
    await patch("complaints", "id=eq." + rowId,
      { body: "أثر إثبات آلي — يمكن حذفه من Table Editor ← complaints" }, dir);
  }

  /* ---------- ⑩ الطابور: على الطريقة التي ينفّذها flushQueue فعلًا ----------
     كل الإثباتات أعلاه تستعمل إدراجًا عاديًّا. وهذا بالضبط ما جعل العطل
     خفيًّا: العميل لا يُدرج، بل **upsert بمفتاح client_id**، وكان يفشل بـ42P10
     لأن الفهرس الفريد جزئيّ — فلا تُزامَن ولا عملية واحدة. نقيس ما يفعله هو. */
  console.log("\n▸ ⑩ مسار الكتابة الحقيقي — upsert بمفتاح client_id");
  const qid = "vq-" + Date.now().toString(36);
  const qrow = { action: "إثبات مسار الطابور", target: "verify-live", detail: qid, client_id: qid };
  const upsertAudit = () => fetch(`${URL_}/rest/v1/audit_log?on_conflict=client_id`, {
    method: "POST",
    headers: { ...H(dir), Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(qrow),
  });
  const insAudit = () => fetch(`${URL_}/rest/v1/audit_log`, {
    method: "POST",
    headers: { ...H(dir), Prefer: "return=representation" },
    body: JSON.stringify(qrow),
  });

  const up1 = await upsertAudit();
  const up1Body = await up1.json().catch(() => null);
  const isOnConflict = up1.status >= 400 && /42P10|on conflict/i.test(JSON.stringify(up1Body));

  if (!isOnConflict) {
    chk(up1.status === 201 && up1Body?.length === 1,
        "upsert بمفتاح client_id يعمل ⇒ المزامنة تصل فعلًا",
        `HTTP ${up1.status} · ${JSON.stringify(up1Body).slice(0, 140)}`);
    const up2 = await upsertAudit();
    chk(up2.status === 200 || up2.status === 201,
        "وإعادة الإرسال بنفس المفتاح تُحدِّث الصفّ نفسه (لا ازدواج)", "HTTP " + up2.status);
    const cnt = await get("audit_log", "select=id&client_id=eq." + qid, dir);
    chk((cnt.body || []).length === 1, "وصفّ واحد فقط في القاعدة بعد الإرسالين");
  } else {
    /* لم يُشغَّل sql/006: upsert مرفوض. نُثبت أن الحارس في العميل يُنجِح
       فالمنصّة تعمل — لكن نُعلن العلّة بدل أن نُدّعي السلامة. */
    no("upsert بمفتاح client_id ⇒ مرفوض (42P10)",
       "الفهرس الفريد على client_id جزئيّ — شغّلي sql/006_apply_004_and_005.sql");
    const ins = await insAudit();
    const insBody = await ins.json().catch(() => null);
    chk(ins.status === 201 && insBody?.length === 1,
        "والحارس في العميل (إدراج عادي) يُنجِح ⇒ الأثر يصل ولا يُجمَّد الطابور");
    ok("الخلاصة: المنصّة تعمل الآن بالإدراج، وsql/006 يُعيد upsert فيُحدِّث بدل أن يُطوي");
  }
  if (!KEEP) {
    await fetch(`${URL_}/rest/v1/audit_log?client_id=eq.${encodeURIComponent(qid)}`,
      { method: "DELETE", headers: H(dir) });
  }

  console.log("\n" + "─".repeat(64));
  console.log(`\x1b[1m${pass} نجح · ${fail} فشل\x1b[0m`);
  console.log(fail === 0
    ? "\x1b[32m\x1b[1mمسارات الجلب والاعتراض والكتابة تعمل حيًّا على الخادم الحقيقي.\x1b[0m\n"
    : "\x1b[31m\x1b[1mهناك فشل — راجع أعلاه.\x1b[0m\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\n\x1b[31m✗ توقّف:\x1b[0m " + (e.message || e) + "\n");
  process.exit(2);
});
