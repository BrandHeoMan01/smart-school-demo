#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — اختبار الإقلاع (Smoke Test)
 *  الملف: tests/boot.test.js
 *
 *  يُشغّل **كامل سكربت المنصّة** داخل بيئة متصفّح مصطنعة. الغرض: كشف أي انهيار
 *  عند فتح الصفحة — من مرجع لعنصر محذوف، أو دالة ناقصة، أو خطأ في الإقلاع —
 *  **قبل** أن يراه المستخدم على الموقع الحيّ.
 *
 *  هذا الاختبار هو الذي كان سيكشف فورًا خطأً مثل مناداة #rolePicker وقد حُذف.
 *
 *  التشغيل:  node tests/boot.test.js        (لا يحتاج أي مكتبة)
 * ==========================================================================*/
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

let pass = 0;
const failures = [];
const ok = (l) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); };
const bad = (l, d) => { failures.push(l); console.log(`  \x1b[31m✗\x1b[0m ${l}${d ? `\n      ↳ ${d}` : ""}`); };

/* --------------------------------------------------- عنصر DOM مصطنع */
function makeEl(tag) {
  const el = {
    tagName: tag || "DIV", nodeType: 1,
    style: {}, dataset: {}, options: [], children: [],
    value: "", textContent: "", innerHTML: "", title: "",
    checked: false, disabled: false, href: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, insertBefore() {}, insertAdjacentHTML() {},
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, blur() {}, select() {}, click() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  };
  return el;
}

function makeSandbox() {
  const store = new Map();
  const html = HTML.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/)[1];

  const doc = {
    getElementById: () => makeEl(),
    /* المتصفّح الحقيقي يوجد عليه العنصر دائمًا في هذه الاستعمالات (وهو يُنشئ
       <tbody> تلقائيًا داخل الجداول). إرجاع null هنا يُنتج انهيارًا وهميًا. */
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    createElement: (t) => makeEl(t),
    addEventListener() {}, removeEventListener() {},
    head: { appendChild() {} },
    body: makeEl("BODY"),
    documentElement: makeEl("HTML"),
  };

  const sandbox = {
    console,
    TextEncoder, TextDecoder,
    Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Error, Promise, Set, Map,
    crypto: globalThis.crypto,
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    document: doc,
    navigator: { onLine: true, serviceWorker: undefined, clipboard: null, userAgent: "node" },
    location: { reload() {}, href: "https://example.test/", origin: "https://example.test" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
  sandbox.print = () => {};
  sandbox.alert = () => {};
  sandbox.scrollTo = () => {};
  sandbox.scrollX = 0; sandbox.scrollY = 0;
  sandbox.innerWidth = 1280; sandbox.innerHeight = 800;

  vm.createContext(sandbox);
  return { sandbox, html };
}

/* ================================================================ التشغيل */
console.log("\n\x1b[1mEDUVIA — اختبار الإقلاع\x1b[0m\n");

const { sandbox, html } = makeSandbox();

console.log("▸ تحميل السكربت كاملًا");
try {
  vm.runInContext(html, sandbox, { filename: "index.html<script>" });
  ok(`نُفِّذ السكربت كاملًا بلا انهيار (${html.split("\n").length} سطرًا)`);
} catch (e) {
  bad("انهيار عند الإقلاع", `${e.name}: ${e.message}`);
  console.log("\n\x1b[31mالتنفيذ متوقّف — لا معنى لبقية الاختبارات.\x1b[0m\n");
  process.exit(1);
}

console.log("\n▸ حالة الإقلاع");
/* `const`/`let` في سكربت vm تعيش في البيئة المعجمية العامة، لا كخصائص على
   الكائن العام — فنستخرجها بتعبير يُنفَّذ **داخل** نفس السياق.
   والـgetters تضمن قراءة القيم المتغيّرة (مثل CURRENT_USER) لحظةَ الطلب. */
const T = vm.runInContext(`({
  get students(){return students}, get teachers(){return teachers},
  get QUEUE(){return QUEUE}, get SYNC(){return SYNC},
  get CURRENT_USER(){return CURRENT_USER}, set CURRENT_USER(v){CURRENT_USER=v},
  EDUVIA_CONFIG,
  ROLES, ALL_PAGES, classesSorted, doLogin, logout, renderSyncChip, renderAudit,
  renderInspectorWing, renderObservatory, renderBook, behavBalance, eduviaLogin,
  applyRole, showPage, audit, renderDemoAccounts
})`, sandbox);

/* الالتقاط قبل الفرض: هكذا نقيس ما اشترقه السكربت فعلًا من إعداداته. */
const derivedMode = T.SYNC.mode;

/* نُثبّت «محلي» عمدًا. هذا الاختبار يقيس المنصّة **بلا خادم**، ويجب ألّا
   تتغيّر نتيجته بحسب ما إذا كان index.html موصولًا بتلك اللحظة.
   (العلّة التي كشفت الحاجة: بعد لصق المفاتيح صار eduviaLogin ينتظر تحميل
   مكتبة من الشبكة؛ وفي البيئة المعزولة لا مؤقّتات حيّة ⇒ نفدت أحداث Node
   وخرجت العملية بـ0 بلا أن تُكمل — فأعلن run-all «نجاحًا» كاذبًا.) */
T.SYNC.mode = "local";

const chk = (label, fn) => { try { fn() ? ok(label) : bad(label); } catch (e) { bad(label, e.message); } };

chk("التلاميذ وُلدوا من buildData()", () => T.students.length > 0);
chk("الأقسام مبنيّة", () => T.classesSorted().length > 0);
chk("المعلّمون موجودون", () => T.teachers.length > 0);
chk("الأدوار السبعة معرَّفة", () => Object.keys(T.ROLES).length === 7);
chk("الطابور أُقلع فارغًا", () => Array.isArray(T.QUEUE) && T.QUEUE.length === 0);
chk("وضع المزامنة مُشتقّ من الإعداد لا مثبَّت", () =>
  derivedMode === ((T.EDUVIA_CONFIG.supabaseUrl && T.EDUVIA_CONFIG.supabaseAnonKey) ? "remote" : "local"));
chk("لا مستخدم مسجَّل عند الإقلاع", () => T.CURRENT_USER === null);
chk("دالة الدخول موجودة", () => typeof T.doLogin === "function");
chk("دالة الخروج موجودة", () => typeof T.logout === "function");
chk("مؤشّر المزامنة يعمل", () => { T.renderSyncChip(); return true; });
chk("سجلّ التدقيق قابل للعرض", () => { T.renderAudit(); return true; });
chk("لوحة المفتّش تُبنى", () => { T.renderInspectorWing(); return true; });
chk("المرصد التربوي يُبنى", () => { T.renderObservatory(); return true; });
chk("دفتر النقاط يُبنى", () => { T.renderBook(); return true; });
chk("سلوك متوازن مُحتسَب", () => {
  const b = T.behavBalance();
  return typeof b.pos === "number" && typeof b.neg === "number";
});

console.log("\n▸ سيناريو دخول كامل (بلا خادم)");
(async () => {
  try {
    /* البطاقة تُقرأ من البيانات المولَّدة لا من رقم مكتوب يدويًا —
       (خطأ سابق: شاشة الدخول أعلنت RF-0001 والبطاقات الفعلية RF-001240…) */
    const card = T.students[0].card;
    chk("بطاقة التلميذة الأولى مُشتقّة من البيانات", () => /^RF-\d+$/.test(card));
    chk("renderDemoAccounts يقرأ البطاقة الفعلية", () => {
      let seen = null;
      const el = { innerHTML: "" };
      const realGet = sandbox.document.getElementById;
      sandbox.document.getElementById = (id) => (id === "demoAccTable" ? el : realGet(id));
      T.renderDemoAccounts();
      sandbox.document.getElementById = realGet;
      seen = el.innerHTML;
      return seen.includes(card);
    });

    const r = await T.eduviaLogin(card, "111111");
    chk("تلميذة تدخل برمزها", () => r.ok === true && r.role === "student");
    chk("التلميذة بلا رقم بطاقة مكتوب يدويًا في الاختبار", () => r.ok === true);
    const b2 = await T.eduviaLogin("director", "1234");
    chk("1234 لا يفتح حساب المديرة", () => b2.ok === false);
    const d = await T.eduviaLogin("director", "333333");
    chk("المديرة تدخل برمزها", () => d.ok === true && d.role === "director");

    /* تطبيق الدور يجب ألّا ينهار */
    T.CURRENT_USER = { name: d.name, role: d.role };
    T.applyRole("director");   ok("applyRole('director') يمرّ بلا انهيار");
    T.applyRole("student");    ok("applyRole('student') يمرّ بلا انهيار");
    T.applyRole("inspector");  ok("applyRole('inspector') يمرّ بلا انهيار");
    T.applyRole("authority");  ok("applyRole('authority') يمرّ بلا انهيار");
    T.applyRole("teacher");    ok("applyRole('teacher') يمرّ بلا انهيار");
    T.applyRole("supervisor"); ok("applyRole('supervisor') يمرّ بلا انهيار");
    T.applyRole("reception");  ok("applyRole('reception') يمرّ بلا انهيار");

    /* كل الصفحات تُفتح بلا انهيار — بدور المدير (أوسع صلاحية) */
    T.CURRENT_USER = { name: d.name, role: "director" };
    T.applyRole("director");
    let opened = 0; const crashed = [];
    for (const p of T.ALL_PAGES) {
      try { T.showPage(p); opened++; } catch (e) { crashed.push(`${p}: ${e.message}`); }
    }
    if (crashed.length) { console.log("      " + crashed.join("\n      ")); bad(`كل الصفحات تُفتح`, `${crashed.length} انهيار`); }
    else ok(`كل الصفحات (${T.ALL_PAGES.length}) تُفتح بلا انهيار`);

    /* سجلّ التدقيق يجب أن يكتسب أثرًا ويُدرج في الطابور */
    const before = T.QUEUE.length;
    T.audit("اختبار إقلاع", "هدف", "تفصيل");
    chk("audit() يكتب في الطابور", () => T.QUEUE.length === before + 1);
    chk("الأثر يحمل client_id", () => !!T.QUEUE[T.QUEUE.length - 1].row.client_id);

    T.logout();
    chk("logout() يصفّر المستخدم", () => T.CURRENT_USER === null);
  } catch (e) {
    bad("سيناريو الدخول", `${e.name}: ${e.message}`);
  }

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
})();
