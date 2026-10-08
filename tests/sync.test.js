#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — اختبار طبقة المزامنة والمصادقة
 *  الملف: tests/sync.test.js
 *
 *  يستخرج بلوك «الخادم والمزامنة والمصادقة» من index.html ويشغّله في بيئة
 *  معزولة (vm) مع بدائل للمتصفّح — ثم يتحقّق من:
 *    · الطابور: الإضافة، الثبات، سقف الحجم، مفتاح منع التكرار
 *    · الإرسال: إزالة المكرر (23505) بدل الفشل، والاحتفاظ عند الفشل الحقيقي
 *    · المؤشّر: النصّ الصحيح لكل حالة (محلي / بلا شبكة / بانتظار / متزامن)
 *    · تحويل البطاقة إلى بريد
 *    · المصادقة المحلية: رمز صحيح ينجح، خاطئ يُرفض، ومعرِّف مجهول يُرفض
 *
 *  التشغيل:  node tests/sync.test.js        (لا يحتاج أي مكتبة)
 * ==========================================================================*/
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/* ------------------------------------------------------- استخراج البلوك */
const START = "/* ===== EDUVIA — الخادم والمزامنة والمصادقة =====*/".replace("*/", "");
const END = "/* ===== الثبات";
const i0 = HTML.indexOf("/* ===== EDUVIA — الخادم والمزامنة والمصادقة");
const i1 = HTML.indexOf(END, i0);
if (i0 < 0 || i1 < 0) {
  console.error("✖ تعذّر العثور على بلوك المزامنة في index.html — هل تغيّر تعليقه؟");
  process.exit(2);
}
const BLOCK = HTML.slice(i0, i1);

/* ------------------------------------------------- استخراج المُعينات
   hydrate() لا يعيش في فراغ: يستعمل ثوابت الواجهة (SUBJECTS) ودوالّها
   (assignAcademics, clampMark, computeMark). نستخرجها **من index.html نفسه**
   لا نُعيد كتابتها هنا — فنسخة الاختبار المزيّفة تُخفي الأعطال الحقيقية.

   المدى محسوب بدقّة ليتجنّب `let students=...`: لو دخل في النصّ لصار ارتباطًا
   معجميًا يحجب خاصية البيئة، فيقرأ الاختبار مصفوفةً غير التي تعدّلها الدوال. */
function slice(from, to) {
  const a = HTML.indexOf(from);
  const b = HTML.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`تعذّر استخراج المُعينات: ${from.slice(0, 30)}`);
  return HTML.slice(a, b);
}
const CONSTS = slice('const WEEKDAYS=["الأحد"', "\nlet students=[], teachers=");
const ACADEMICS = slice("function assignAcademics(s){", "\nfunction setAcc(k){");

/* ------------------------------------------------------------- الإحصاء */
let pass = 0;
const failures = [];
const ok = (l) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); };
const bad = (l, d) => { failures.push(l); console.log(`  \x1b[31m✗\x1b[0m ${l}${d ? `\n      ↳ ${d}` : ""}`); };
function eq(a, e, l) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) ok(l); else bad(l, `المتوقّع ${E} · الواقع ${A}`);
}
function truthy(v, l) { v ? ok(l) : bad(l, `القيمة ${JSON.stringify(v)}`); }

/* ------------------------------------------------------- بيئة المتصفّح */
function makeSandbox({ students = [], notes = [], online = true, mode = "local" } = {}) {
  const store = new Map();
  const el = () => ({ textContent: "", className: "", title: "", innerHTML: "", style: {} });

  const sandbox = {
    console,
    TextEncoder,
    crypto: globalThis.crypto,
    setTimeout: () => 0,          // لا نريد مؤقّتات حقيقية تُبقي العملية حيّة
    clearTimeout: () => {},
    setInterval: () => 0,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: { getElementById: () => el(), createElement: () => el(), head: { appendChild() {} } },
    navigator: { onLine: online },
    students,
    /* غيابها كان يجعل hydrate() يرمي ReferenceError في البيئة المعزولة
       فتبدو ناجحةً وهي لم تُنفَّذ أصلًا. */
    NOTES: notes, nextId: 1, teachers: [], gateLog: [], notifs: [],
  };
  sandbox.window = {
    addEventListener: () => {},
    supabase: null,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    CONSTS + "\n" + ACADEMICS + "\n" + BLOCK +
    `\n;globalThis.__T={SYNC,QUEUE,enqueue,flushQueue,renderSyncChip,toEmail,eduviaLogin,` +
    `buildAccounts,sha256,loadQueue,saveQueue,DEMO_STAFF,DEMO_PIN_STUDENT,newClientId,` +
    `rowFor,NOTE_STATUS_DB,ATT_STATE_DB,cloudIdOf,sidOrNull,hydrate,pendingClientIds,` +
    /* BOOK و announcements ارتباطان معجميان من النصّ المستخرج ⇒ نُخرجهما
       بقارئ (getter) وإلّا قرأ الاختبار خاصيّةً أخرى غير التي تعدّلها الدوال. */
    `get BOOK(){return BOOK}, get NOTES(){return NOTES}, get announcements(){return announcements}};`,
    sandbox,
    { filename: "eduvia-sync.js" }
  );
  /* نُثبّت الوضع عمدًا بدل الاعتماد على إعداد index.html — كي تُعطي المجموعة
     النتيجة نفسها سواء كان المشروع موصولًا بخادم أم لا. الاختبارات التي تريد
     «remote» تضبطه صراحةً بعد الاستدعاء. */
  sandbox.__T.SYNC.mode = mode;
  return { T: sandbox.__T, sandbox, store };
}

/* بيانات تلاميذ وهمية للمصادقة */
const STUDENTS = [
  { id: 1, name: "مريم بن علي", card: "RF-0001", cls: "1أ" },
  { id: 2, name: "آية بن ساسي", card: "RF-0002", cls: "1أ" },
  { id: 3, name: "نور الهدى العايب", card: "RF-0003", cls: "1ب" },
];

/* =========================================================== الاختبارات */
async function main() {
  console.log("\n\x1b[1mEDUVIA — اختبار المزامنة والمصادقة\x1b[0m\n");

  /* ------------------------------------------------ ١. تحويل البطاقة */
  console.log("▸ تحويل مُعرِّف الدخول إلى بريد");
  {
    const { T } = makeSandbox();
    eq(T.toEmail("RF-0001"), "rf-0001@eduvia.local", "بطاقة RF-0001 ← rf-0001@eduvia.local");
    eq(T.toEmail("DIRECTOR"), "director@eduvia.local", "يُصغَّر الحرف تلقائيًا");
    eq(T.toEmail("  RF-0002  "), "rf-0002@eduvia.local", "تُقلَّم الفراغات الطرفية");
    eq(T.toEmail("RF T001"), "rf-t001@eduvia.local", "الرموز غير الآمنة تُستبدَل");
  }

  /* ------------------------------------------------ ٢. الطابور */
  console.log("\n▸ الطابور المحلي");
  {
    const { T, store } = makeSandbox();
    eq(T.QUEUE.length, 0, "يبدأ الطابور فارغًا");

    const a = T.enqueue("audit_log", { action: "عرض", target: "تلميذة" });
    const b = T.enqueue("behaviour_notes", { body: "ملاحظة" });
    eq(T.QUEUE.length, 2, "الإدراج يزيد الطابور");
    truthy(a.clientId && a.clientId !== b.clientId, "لكل عملية clientId فريد (منع الازدواج)");
    eq(a.row.client_id, a.clientId, "client_id مكتوب داخل الصفّ نفسه (يقرأه الفهرس الفريد)");
    truthy(store.has("eduvia-queue-v1"), "الطابور محفوظ في localStorage (يبقى بعد إعادة التحميل)");
  }
  {
    const { T } = makeSandbox();
    T.enqueue("audit_log", { action: "x" });
    const restored = T.loadQueue();
    eq(restored.length, 1, "الطابور يُستعاد بعد إعادة التحميل");
    eq(restored[0].table, "audit_log", "الجدول محفوظ");
    eq(restored[0].tries, 0, "عدّاد المحاولات يبدأ من صفر");
  }
  {
    const { T } = makeSandbox();
    eq(T.enqueue("audit_log", null), null, "صفّ فارغ لا يُدرَج");
    eq(T.QUEUE.length, 0, "الطابور يبقى فارغًا");
  }

  /* ------------------------------------------------ ٣. الإرسال */
  console.log("\n▸ الإرسال وإزالة التكرار");
  {
    const { T } = makeSandbox();
    let calls = 0;
    T.SYNC.mode = "remote"; T.SYNC.online = true;
    T.SYNC.client = { from: () => ({ upsert: async () => { calls++; return { error: null }; } }) };

    T.enqueue("audit_log", { action: "أ" });
    T.enqueue("audit_log", { action: "ب" });
    T.enqueue("audit_log", { action: "ج" });
    await T.flushQueue();
    eq(calls, 3, "أُرسلت العمليات الثلاث");
    eq(T.QUEUE.length, 0, "الطابور صار فارغًا بعد النجاح");
    truthy(T.SYNC.lastSync, "وقت آخر مزامنة مُسجَّل");
  }
  {
    /* المفتاح: ازدواج على الخادم = نجاح لا فشل (وصل سابقًا ثم انقطع الردّ) */
    const { T } = makeSandbox();
    T.SYNC.mode = "remote"; T.SYNC.online = true;
    T.SYNC.client = { from: () => ({ upsert: async () => ({ error: { code: "23505", message: "duplicate key" } }) }) };
    T.enqueue("audit_log", { action: "أ" });
    await T.flushQueue();
    eq(T.QUEUE.length, 0, "الازدواج 23505 يُعالَج كنجاح (لا تكرار ولا تعليق للطابور)");
  }
  {
    /* فشل حقيقي ⇒ يبقى في الطابور وتزداد المحاولات */
    const { T } = makeSandbox();
    T.SYNC.mode = "remote"; T.SYNC.online = true;
    T.SYNC.client = { from: () => ({ upsert: async () => ({ error: { code: "42P01", message: "relation does not exist" } }) }) };
    T.enqueue("audit_log", { action: "أ" });
    await T.flushQueue();
    eq(T.QUEUE.length, 1, "الفشل الحقيقي يُبقي العملية في الطابور (لا ضياع)");
    eq(T.QUEUE[0].tries, 1, "عدّاد المحاولات يزداد");
    truthy(T.SYNC.lastError, "الخطأ مُسجَّل للمراجعة");
  }
  {
    /* بلا شبكة ⇒ لا محاولة إرسال إطلاقًا */
    const { T } = makeSandbox();
    let calls = 0;
    T.SYNC.mode = "remote"; T.SYNC.online = false;
    T.SYNC.client = { from: () => ({ upsert: async () => { calls++; return { error: null }; } }) };
    T.enqueue("audit_log", { action: "أ" });
    await T.flushQueue();
    eq(calls, 0, "بلا شبكة: لا محاولة إرسال");
    eq(T.QUEUE.length, 1, "العملية محفوظة بانتظار الشبكة");
  }
  {
    /* الوضع المحلي ⇒ لا إرسال أبدًا، لكن لا ضياع أيضًا */
    const { T } = makeSandbox();
    let calls = 0;
    T.SYNC.client = { from: () => ({ upsert: async () => { calls++; return { error: null }; } }) };
    T.enqueue("audit_log", { action: "أ" });
    await T.flushQueue();
    eq(calls, 0, "الوضع المحلي: لا يحاول الإرسال");
    eq(T.QUEUE.length, 1, "التغيير محفوظ محليًا في كل الأحوال");
  }

  /* ------------------------------------------------ ٣ب. تعديل صفٍّ قائم */
  console.log("\n▸ تعديل صفٍّ قائم على الخادم (اعتراض / إلغاء)");
  {
    const { T } = makeSandbox({ mode: "remote" });

    /* حارس: تعديل بلا شرط يمسّ **كل** صفّ تسمح به RLS. */
    eq(T.enqueue("behaviour_notes", { reply: "س" }, { op: "update", match: {} }), null,
       "تعديل بلا شرط يُرفض (وإلّا عدّلنا كل الصفوف!)");

    const it = T.enqueue("behaviour_notes", { reply: "اعتراضي" },
                         { op: "update", match: { id: "n1" } });
    eq(it.op, "update", "النوع «تعديل» لا upsert");
    eq(it.match.id, "n1", "شرط الصفّ محفوظ");
    truthy(!("client_id" in it.row), "لا client_id في التعديل — الصفّ قائم على الخادم أصلًا");
  }
  {
    /* تعديل ناجح: الخادم يعيد الصفّ المتأثّر */
    const { T } = makeSandbox({ mode: "remote" });
    const seen = [];
    T.SYNC.client = { from: (t) => ({ update: (row) => ({ select: () => ({
      eq: (k, v) => { seen.push({ t, row, k, v });
                      return Promise.resolve({ data: [{ id: v }], error: null }); }
    }) }) }) };

    T.enqueue("behaviour_notes", { reply: "اعتراضي" }, { op: "update", match: { id: "n1" } });
    await T.flushQueue();
    eq(T.QUEUE.length, 0, "التعديل وصل ⇒ خرج من الطابور");
    eq(seen[0].k, "id", "الشرط على المفتاح");
    eq(seen[0].v, "n1", "الصفّ المستهدف هو نفسه");
    eq(seen[0].row.reply, "اعتراضي", "نصّ الاعتراض هو المُرسَل");
    truthy(!("status" in seen[0].row),
      "التلميذة لا تُرسل status — الخادم يمنعها بمنحة العمود");
  }
  {
    /* صفر صفوف: RLS رشّحته بصمت. ليس خطأً ظاهرًا — وليس نجاحًا. */
    const { T } = makeSandbox({ mode: "remote" });
    T.SYNC.client = { from: () => ({ update: () => ({ select: () => ({
      eq: () => Promise.resolve({ data: [], error: null })
    }) }) }) };

    T.enqueue("behaviour_notes", { status: "revoked" }, { op: "update", match: { id: "n9" } });
    await T.flushQueue();
    eq(T.QUEUE.length, 0, "لا يبقى عالقًا في الطابور أبدًا");
    eq(T.SYNC.blocked, 1, "صفر صفوف يُحتسب «ردّه الخادم» ولا يُتجاهل بصمت");
    eq(T.SYNC.lastBlocked.table, "behaviour_notes", "الجدول مُسجَّل للمراجعة");
  }

  /* ------------------------------------------------ ٤. خريطة التحويل */
  console.log("\n▸ خريطة الواجهة ← القاعدة (العربية ← اللاتينية)");
  {
    const { T } = makeSandbox();

    const note = T.rowFor("behaviour_notes", {
      student_id: "u-1", category: "إخلال بالهدوء", kind: "neg", body: "ضجيج",
      subject: "الرياضيات", noted_on: "2026-10-01", status: "قائم", author_name: "الأستاذة"
    });
    eq(note.status, "open", "«قائم» ← open");
    eq(note.kind, "neg", "التصنيف يمرّ كما هو");
    eq(note.category, "إخلال بالهدوء", "الفئة العربية تبقى عربية (بيانات لا مفتاح)");
    truthy(!("school_id" in note), "لا يُرسَل school_id — الخادم يشتقّه (ضدّ تزوير المؤسسة)");
    truthy(!("id" in note), "لا يُرسَل id — الخادم يولّده");

    eq(T.rowFor("behaviour_notes", { status: "معترَض عليه" }).status, "open",
       "«معترَض عليه» ← open (الاعتراض لا يغيّر الحالة — المشغّل يفرض ذلك)");
    eq(T.rowFor("behaviour_notes", { status: "ملغى" }).status, "revoked", "«ملغى» ← revoked");
    eq(T.rowFor("behaviour_notes", { status: "مؤرشف" }).status, "archived", "«مؤرشف» ← archived");
    eq(T.rowFor("behaviour_notes", { status: "شيء غريب" }).status, "open",
       "حالة مجهولة تعود إلى open (الفشل الآمن: لا صفّ مقفل بصمت)");

    eq(T.rowFor("attendance", { state: "present" }).state, "present", "حضور: present");
    eq(T.rowFor("attendance", { state: "late" }).state, "late", "حضور: late");
    eq(T.rowFor("outbox", { channel: "sms", body: "نصّ" }).status, "queued",
       "الرسالة تُدرَج بحالة queued لا sent (لا نكذب على أنفسنا)");
    eq(T.rowFor("outbox", { channel: "call" }).channel, "call", "قناة الاتصال تمرّ");

    const au = T.rowFor("audit_log", { action: "عرض", target: undefined, detail: undefined });
    eq(au.target, null, "الحقول الفارغة تصير null لا undefined (يقرأها Postgres)");
    eq(au.detail, null, "التفصيل الفارغ null");
  }

  /* ------------------------------------------------ ٤ب. معبر المعرّفات */
  console.log("\n▸ معبر المعرّفات (رقم محلّي ⇄ uuid الخادم)");
  {
    const { T } = makeSandbox({
      mode: "remote",
      students: [
        { id: 1, name: "مريم", card: "RF-0001", cls: "1أ", cloudId: "u-aaa" },
        { id: 2, name: "آية",  card: "RF-0002", cls: "1أ" },   /* لم تُنشأ على الخادم بعد */
      ],
    });

    eq(T.cloudIdOf(1), "u-aaa", "رقم محلّي ← uuid الخادم");
    eq(T.cloudIdOf(2), null, "تلميذة بلا uuid (أُضيفت للتوّ) ⇒ null");
    eq(T.cloudIdOf(99), null, "رقم مجهول ⇒ null");

    const n = T.rowFor("behaviour_notes", {
      student_id: 1, category: "إخلال بالهدوء", kind: "neg", body: "x",
      subject: "السلوك", noted_on: "2026-10-01", status: "قائم"
    });
    eq(n.student_id, "u-aaa", "الصفّ يُرسَل بـuuid لا برقم (كان يُرفض: invalid uuid)");

    eq(T.rowFor("behaviour_notes", { student_id: 2, body: "x" }), null,
       "بلا uuid ⇒ لا نُرسل صفًّا يعرف الخادم أنه سيرفضه");

    const L = makeSandbox({ students: [{ id: 7, name: "س", card: "RF-9" }] });
    eq(L.T.cloudIdOf(7), 7, "وضع محلي بلا خادم: الرقم يمرّ كما هو");
  }

  /* ------------------------------------------------ ٤ج. الجلب (hydration) */
  console.log("\n▸ الجلب من الخادم (hydration)");
  {
    /* خادم وهمي: نفس شكل ردّ supabase-js (‏{data,error}). */
    const fakeServer = (rows) => ({
      auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
      from: (t) => ({ select: async () => ({ data: rows[t] || [], error: null }) }),
    });
    const TODAY = new Date().toISOString().slice(0, 10);
    const DATA = {
      students: [
        { id: "a1", card_no: "RF-0001", full_name: "مريم بن علي", grade: 1, section: "أ", class_label: "1أ", parent_name: "السيد كمال", parent_phone: "0551000001", notify_pref: "sms" },
        { id: "a2", card_no: "RF-0002", full_name: "آية بن ساسي", grade: 1, section: "أ", class_label: "1أ", parent_name: "السيد رشيد", parent_phone: "0551000002", notify_pref: "app" },
      ],
      behaviour_notes: [
        { id: "n1", student_id: "a1", category: "تحسّن ملحوظ", kind: "pos", body: "أحسنتِ", subject: "اللغة العربية", noted_on: "2026-10-01", author_name: "الأستاذة", reply: null, replied_at: null, status: "open", client_id: null },
        { id: "n2", student_id: "a1", category: "إخلال بالهدوء", kind: "neg", body: "ضجيج", subject: "الرياضيات", noted_on: "2026-10-02", author_name: "الأستاذة", reply: "اعتراضي", replied_at: "2026-10-03T09:00:00Z", status: "open", client_id: null },
        { id: "n3", student_id: "a1", category: "تعاون ومساعدة", kind: "pos", body: "نسخة الخادم", subject: "السلوك", noted_on: "2026-10-04", author_name: "أ", reply: null, replied_at: null, status: "open", client_id: "cl-pend" },
      ],
      grades: [
        { id: "g1", student_id: "a1", subject: "اللغة العربية", label: "فرض 1", kind: "summative", mark: 8 },
        { id: "g2", student_id: "a1", subject: "اللغة العربية", label: "مشاركة صفّية", kind: "formative", mark: 10 },
      ],
      attendance: [{ student_id: "a1", day: TODAY, state: "late", at_time: "08:20" }],
      staff: [{ full_name: "السيدة زهية", job_title: "مديرة المؤسسة", class_label: "الإدارة" }],
      announcements: [{ title: "إعلان الخادم", body: "نصّ" }],
      notifications: [{ kind: "system", body: "خبر", at_time: "08:00" }],
    };

    const { T, sandbox } = makeSandbox({
      mode: "remote",
      notes: [{ id: "loc1", clientId: "cl-pend", sid: 1, date: "2026-10-05",
                t: "أ", subj: "السلوك", cat: "تعاون ومساعدة",
                note: "صفّ محلّي معلّق", kind: "pos", status: "قائم" }],
    });
    /* صفّ معلّق في الطابور (نفس client_id) — أصدق من نسخة الخادم، فلا يُدهَس. */
    T.enqueue("behaviour_notes", { client_id: "cl-pend", body: "صفّ محلّي معلّق" });
    T.SYNC.client = fakeServer(DATA);

    const r = await T.hydrate();
    truthy(r.ok, "الجلب نجح");
    eq(r.students, 2, "تلميذتان وصلتا من الخادم");

    const S = sandbox.students;
    eq(S.length, 2, "المصفوفة المحلّية استُبدلت بصفوف المدرسة");
    eq(S[0].name, "مريم بن علي", "الاسم من الخادم لا من العشوائية");
    eq(S[0].cloudId, "a1", "uuid محفوظ على الصفّ — به يمرّ كل write لاحق");
    eq(S[1].cls, "1أ", "القسم من الخادم");
    eq(S[1].notify, "تطبيق", "تفضيل الإشعار: app ← تطبيق");
    eq(S[0].state, "late", "حالة اليوم من سجلّ الحضور");
    eq(S[0].time, "08:20", "وقت الدخول من الخادم");

    const b = T.BOOK[S[0].id + "|اللغة العربية"];
    truthy(b && b.entries.length === 2, "دفتر النقاط بُذر من صفوف الخادم");
    eq(b.entries[0].mark, 8, "العلامة كما هي على الخادم");
    eq(b.entries[1].kind, "formative", "النوع محفوظ (التكويني لا يدخل المعدّل)");
    eq(S[0].marks[0]["اللغة العربية"], 8, "المعدّل محسوب من صفوف الخادم لا مُخمَّن");
    truthy(!S[0].marksPartial.includes("اللغة العربية"),
      "المادة ذات النقاط على الخادم ليست في قائمة «لم تُدخَل»");
    eq(S[0].marksPartial.length, 6, "الموادّ الستّ الباقية مُعلَنة صراحةً لا ممرَّرة كنقاط رسمية");

    const N = T.NOTES;
    eq(N.length, 3, "ملاحظتان من الخادم + الملاحظة المحلّية المعلّقة");
    eq(N.find(x => x.serverId === "n1").status, "قائم", "بلا اعتراض ⇒ «قائم»");
    eq(N.find(x => x.serverId === "n2").status, "معترَض عليه", "بها اعتراض ⇒ «قيد النظر»");
    truthy(N.some(x => x.clientId === "cl-pend" && x.note === "صفّ محلّي معلّق"),
      "الصفّ المعلّق بقي محلّيًا ولم تدهسه نسخة الخادم");
    truthy(!N.some(x => x.serverId === "n3"), "نسخة الخادم من الصفّ المعلّق أُسقطت");
    eq(N.find(x => x.serverId === "n1").sid, S[0].id, "الملاحظة مربوطة بالتلميذة بالرقم المحلّي");

    eq(sandbox.teachers.length, 1, "الطاقم من الخادم");
    eq(T.announcements[0].title, "إعلان الخادم", "الإعلانات من الخادم");
  }
  {
    const { T } = makeSandbox();     /* وضع محلي */
    const r = await T.hydrate();
    truthy(!r.ok && r.reason === "local",
      "محلي: الجلب يُرفض بلطف — المنصّة تعمل بلا خادم كما هو مبدأها الأول");
  }

  /* ------------------------------------------------ ٥. إعادة استخدام المفتاح */
  console.log("\n▸ تعديل صفّ قائم لا إنشاء نسخة ثانية");
  {
    const { T } = makeSandbox();
    const q1 = T.enqueue("behaviour_notes", { body: "ملاحظة" });
    T.enqueue("behaviour_notes", { client_id: q1.clientId, body: "ملاحظة", reply: "اعتراض" });
    eq(T.QUEUE.length, 2, "الإدراجان في الطابور");
    eq(T.QUEUE[0].clientId, T.QUEUE[1].clientId,
       "لكليهما المفتاح نفسه ⇒ upsert يُحدِّث الصفّ بدل إنشاء ملاحظة ثانية");
    eq(T.QUEUE[1].row.reply, "اعتراض", "نصّ الاعتراض ضمن الصفّ نفسه");
  }

  /* ------------------------------------------------ ٦. المؤشّر */
  console.log("\n▸ مؤشّر الحالة (يقول الحقيقة للمستخدم)");
  {
    const { T, sandbox } = makeSandbox();
    const chip = { textContent: "", className: "", title: "" };
    sandbox.document.getElementById = (id) => (id === "syncChip" ? chip : { style: {} });

    T.renderSyncChip();
    eq(chip.textContent, "وضع محلي", "بلا خادم ⇒ «وضع محلي»");
    eq(chip.className, "syncchip local", "الصنف صحيح");

    T.SYNC.mode = "remote"; T.SYNC.online = false; T.renderSyncChip();
    eq(chip.textContent, "بلا شبكة", "بلا شبكة وطابور فارغ");

    T.enqueue("audit_log", { action: "أ" }); T.renderSyncChip();
    eq(chip.textContent, "بانتظار الشبكة (1)", "بلا شبكة مع طابور: يُظهر العدد");

    T.SYNC.online = true; T.renderSyncChip();
    eq(chip.textContent, "جارٍ المزامنة (1)", "على الشبكة مع طابور معلّق");

    T.QUEUE.length = 0; T.SYNC.lastSync = new Date(); T.renderSyncChip();
    eq(chip.textContent, "متزامن ✓", "طابور فارغ ⇒ متزامن");
  }

  /* ------------------------------------------------ ٥. المصادقة */
  console.log("\n▸ المصادقة المحلية (بطاقة + رمز سرّي)");
  {
    const { T } = makeSandbox({ students: STUDENTS });

    const h1 = await T.sha256("rf-0001|111111");
    const h2 = await T.sha256("rf-0001|111111");
    eq(h1, h2, "التجزئة ثابتة (SHA-256)");
    eq(h1.length, 64, "طول التجزئة 64 حرفًا");
    truthy(h1 !== "111111", "الرمز لا يُخزَّن نصًّا صريحًا");

    const accs = await T.buildAccounts();
    eq(accs.length, 3 + T.DEMO_STAFF.length, "حساب لكل تلميذة + حسابات الطاقم");
    truthy(accs.every((a) => a.hash && a.hash.length === 64), "كل الحسابات مُجزَّأة");
    truthy(accs.some((a) => a.loginId === "RF-0001" && a.role === "student"), "بطاقة التلميذة موجودة");
    truthy(accs.some((a) => a.loginId === "director" && a.role === "director"), "حساب المديرة موجود");

    const good = await T.eduviaLogin("RF-0001", "111111");
    eq(good.ok, true, "دخول برمز صحيح: ينجح");
    eq(good.role, "student", "الدور صحيح");
    eq(good.name, "مريم بن علي", "الاسم من الحساب لا من قائمة");
    eq(good.studentId, 1, "التلميذة مرتبطة بسجلّها");

    eq((await T.eduviaLogin("RF-0001", "000000")).ok, false, "رمز خاطئ: يُرفض");
    eq((await T.eduviaLogin("RF-9999", "111111")).ok, false, "بطاقة مجهولة: تُرفض");
    eq((await T.eduviaLogin("", "111111")).ok, false, "بلا مُعرِّف: يُرفض");
    eq((await T.eduviaLogin("RF-0001", "")).ok, false, "بلا رمز: يُرفض");
    eq((await T.eduviaLogin("rf-0001", "111111")).ok, true, "المعرِّف غير حسّاس لحالة الأحرف");
    eq((await T.eduviaLogin("RF-0002", "111111")).role, "student", "تلميذة أخرى تدخل بحسابها");

    eq((await T.eduviaLogin("director", "333333")).role, "director", "المديرة تدخل برمزها");
    eq((await T.eduviaLogin("director", "111111")).ok, false,
       "رمز التلميذة لا يفتح حساب المديرة");
    eq((await T.eduviaLogin("RF-T001", "222222")).role, "teacher", "المعلّمة تدخل برمزها");

    /* الرمز القديم 1234 يجب ألّا يعمل بأي حال */
    eq((await T.eduviaLogin("director", "1234")).ok, false, "الرمز القديم 1234 لم يعد يعمل");
    eq((await T.eduviaLogin("RF-0001", "1234")).ok, false, "1234 لا يفتح حساب تلميذة");
  }

  /* ------------------------------------------------ الحصيلة */
  console.log("\n" + "─".repeat(64));
  console.log(`__EDUVIA_SUITE_DONE__ ok=${pass} fail=${failures.length}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m\x1b[1m✅ نجحت كل الاختبارات — ${pass} تأكيدًا\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m❌ ${failures.length} فشل من ${pass + failures.length}\x1b[0m`);
  failures.forEach((f) => console.log(`   · ${f}`));
  console.log();
  process.exit(1);
}

main().catch((e) => { console.error("\n\x1b[31m✖ خطأ:\x1b[0m", e); process.exit(1); });
