#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — تدقيق ساكن: الأخطاء التي لا يمسكها تشغيلٌ عابر
 *  الملف: tests/static.test.js
 *
 *  ليست اختبارات سلوك، بل **فحص بنيوي** لما لا يظهر إلّا عند ضغط زرّ بعينه
 *  أو عند إرسال قيمة بعينها. أربعة أخطاء دفعنا ثمنها في هذا المشروع ولم
 *  يكشفها أيّ اختبار سلوكي:
 *
 *    ① **زرٌّ ينادي دالةً غير موجودة.** خطأ صياغةٍ واحد في القالب، أو دالة
 *       حُذفت وبقي زرّها — فيرمي المتصفّح عند الضغط `X is not defined`،
 *       ولا يراه `node --check` (النصّ سليم نحوًا). المستخدمة تضغط فلا يحدث
 *       شيء. **لا يُكتشف إلّا بأن تُضغط كل الأزرار.**
 *    ② **دالتان بالاسم نفسه.** الثانية تحجب الأولى بصمت (JS لا يشتكي)،
 *       فيعمل نصف الملفّ على النسخة الخطأ.
 *    ③ **دالة ميّتة.** لا يناديها شيء: بقايا نسخة قديمة.
 *    ④ **قيمة عربية بلا مقابل في نوع الخادم.** الواجهة تُرسل «حاضر» والخادم
 *       لا يعرف إلّا `present` ⇒ رفض 22P02، وهو خطأ **دائم** يُسقِط الصفّ.
 *
 *  التشغيل:  node tests/static.test.js        (بلا مكتبات)
 * ==========================================================================*/
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const SCHEMA = fs.readFileSync(path.join(ROOT, "sql/001_schema.sql"), "utf8");

/* ------------------------------------------------------------- الإحصاء */
let pass = 0;
const failures = [];
const ok = (l) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); };
const bad = (l, d) => { failures.push(l); console.log(`  \x1b[31m✗\x1b[0m ${l}${d ? `\n      ↳ ${d}` : ""}`); };
const chk = (c, l, d) => (c ? ok(l) : bad(l, d));

/** رقم السطر (١-الأساس) لموضع في الملف — ليكون التقرير قابلًا للفتح مباشرة. */
const lineOf = (idx) => HTML.slice(0, idx).split("\n").length;

/** عدد تكرارات الاسم ككلمة كاملة — للتمييز بين «مستخدم» و«معرّف مرّة واحدة». */
const countWord = (name) =>
  (HTML.match(new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`, "g")) || []).length;

/* ══════════════════════════════════════ ① لماذا هذا الفحص مهمّ ══════════
   الأزرار في هذا المشروع مكتوبة نصًّا داخل قوالب (innerHTML)، لا مربوطة
   بـaddEventListener. فلو تغيّر اسم دالة وبقي الزرّ، لا شيء يكسر: تُبنى
   الصفحة سليمة، ويُبنى الزرّ سليمًا، ويفشل **عند الضغط فقط**.
   وهذه القائمة تُستخرج من HTML نفسه، فيسقط الخطأ لحظة كتابته لا لحظة
   اكتشاف المستخدمة له. */
const HANDLER_RE =
  /\bon(click|change|input|submit|keydown|keyup|focus|blur|mouseover|mouseenter)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/* كلمات ونطاقات موجودة أصلًا في المتصفّح — لا تُعرَّف في المشروع. */
const BUILTIN = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "function",
  "Number", "String", "Boolean", "Array", "Object", "JSON", "Math", "Date",
  "parseInt", "parseFloat", "isNaN", "encodeURIComponent", "decodeURIComponent",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "alert",
  "confirm", "prompt", "Promise", "Error", "RegExp", "Map", "Set", "Symbol",
  "fetch", "require", "structuredClone", "queueMicrotask", "requestAnimationFrame",
]);

/** يُفرِّغ النصوص الحرفية (بين علامات تنصيص) قبل تحليل النداءات.
    بدونه يُقرأ نصٌّ عربيٌّ داخل رسالةٍ كأنّه كود: `toast('ملف PDF (محاكاة)')`
    تُنتج نداءً وهميًّا لـ`PDF()`. وهذا يُنتج إنذارات كاذبة تُفقد التدقيق ثقته. */
function stripStrings(s) {
  return s
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

function collectHandlers() {
  const out = [];
  let m;
  HANDLER_RE.lastIndex = 0;
  while ((m = HANDLER_RE.exec(HTML))) {
    const body = m[2] !== undefined ? m[2] : m[3];
    out.push({ event: m[1], body: stripStrings(body), at: lineOf(m.index) });
  }
  return out;
}

/** هل التعريف في المستوى الأعلى؟ الشرط أن يبدأ **من العمود صفر**.
    التعريفات المحلّية (`const L=t=>…` داخل دالّة) مشروعة ولا تعارض شيئًا —
    فلا تُحسَب تكرارًا ولا موتًا. وتعبيرٌ مُسمّى فوريّ `(function f(){…})()`
    ليس عمود صفر (قبله قوس)، وهو يُنادى فورًا. */
function isTopLevel(html, idx) {
  const lineStart = html.lastIndexOf("\n", idx) + 1;
  return html.slice(lineStart, idx) === "";
}

/** الدوال المُناداه داخل جسم معالج: تعريفٌ يتبعه قوس — مع استثناء نداءات
    الطرق (`x.foo(`) لأنّها ليست دوالًّا عامّة. */
function calledNames(body) {
  const names = new Set();
  const re = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const n = m[1];
    /* `function (` ونحوها: الكلمة السابقة قوس أو فاصلة ⇒ ليست نداءً */
    const before = body.slice(Math.max(0, m.index - 12), m.index);
    if (/(function|new|typeof|return|&&|\|\||[=,:?!(]\s*)$/.test(before)) continue;
    if (!BUILTIN.has(n)) names.add(n);
  }
  return names;
}

function collectDefinitions() {
  const defs = new Map(); // name → [{line, top}]
  const add = (name, idx) => {
    if (!defs.has(name)) defs.set(name, []);
    defs.get(name).push({ line: lineOf(idx), top: isTopLevel(HTML, idx) });
  };
  const pats = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/g,
    /\bwindow\.([A-Za-z_$][\w$]*)\s*=/g,
  ];
  for (const re of pats) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(HTML))) add(m[1], m.index);
  }
  return defs;
}

/* ══════════════════════════════════════ ② أنواع الخادم مقابل دلائل الواجهة ══
   الواجهة تتكلّم عربيًّا («حاضر»، «قائم») والخادم يعرف قيمًا إنجليزية
   (`present`، `open`). الجسر بينهما خريطة في العميل. فإن غاب قيمةٌ من الخريطة
   أُرسِلت العربية كما هي ⇒ رفضٌ دائم من الخادم يُسقِط الصفّ بلا رجعة. */
function enumValues(typeName) {
  const re = new RegExp(`create\\s+type\\s+${typeName}\\s+as\\s+enum\\s*\\(([^)]*)\\)`, "i");
  const m = re.exec(SCHEMA);
  if (!m) return null;
  return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
}

function clientMap(varName) {
  const re = new RegExp(`const\\s+${varName}\\s*=\\s*\\{([\\s\\S]*?)\\};`);
  const m = re.exec(HTML);
  if (!m) return null;
  const pairs = [];
  const pre = /(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*))\s*:\s*(?:"([^"]*)"|'([^']*)')/g;
  let p;
  while ((p = pre.exec(m[1]))) {
    pairs.push({ key: p[1] ?? p[2] ?? p[3], val: p[4] ?? p[5] });
  }
  return pairs;
}

/* ============================================================= التشغيل */
function main() {
  console.log("\n\x1b[1mEDUVIA — تدقيق ساكن لملفّ الواجهة\x1b[0m\n");

  const defs = collectDefinitions();

  /* --------------------------------------------------------- ① الأزرار */
  console.log("▸ كل زرٍّ ينادي دالةً موجودة");
  {
    const handlers = collectHandlers();
    chk(handlers.length > 50, `عُثر على ${handlers.length} معالج حدث في الواجهة`,
      "عددٌ قليلٌ كهذا يعني أنّ الاستخراج فشل لا أنّ الأزرار قليلة");

    const missing = [];
    for (const h of handlers) {
      for (const n of calledNames(h.body)) {
        if (!defs.has(n)) missing.push(`on${h.event} (سطر ${h.at}) ينادي ${n}()`);
      }
    }
    const uniq = [...new Set(missing)];
    chk(uniq.length === 0,
      "لا زرَّ ينادي دالةً غير معرَّفة (لو وُجد لَرمى المتصفّح عند الضغط)",
      uniq.slice(0, 12).join(" · ") + (uniq.length > 12 ? ` … و${uniq.length - 12} غيرها` : ""));
  }

  /* --------------------------------------- ② التكرار (المستوى الأعلى فقط) */
  console.log("\n▸ لا دالتين بالاسم نفسه (الثانية تحجب الأولى بصمت)");
  {
    const dup = [...defs.entries()]
      .filter(([, d]) => d.filter((x) => x.top).length > 1);
    const topCount = [...defs.values()].filter((d) => d.some((x) => x.top)).length;
    chk(dup.length === 0,
      `لا اسمٌ معرَّفًا مرّتين في المستوى الأعلى (${topCount} اسمًا عامًّا من ${defs.size})`,
      dup.map(([n, d]) => `${n}() في الأسطر ${d.map((x) => x.line).join(" و")}`).join(" · "));
  }

  /* --------------------------------------------------------- ③ الميّت */
  console.log("\n▸ لا دوالّ ميّتة (اسمها لا يظهر إلّا في تعريفها)");
  {
    const dead = [];
    for (const [name, d] of defs) {
      const top = d.filter((x) => x.top);
      if (!top.length) continue;                   // محلّية ⇒ ليست دالةً عامّة
      if (top.length > 1) continue;                // مكرّرة ⇒ محسوبة أعلاه
      if (countWord(name) <= 1) dead.push(`${name}() (سطر ${top[0].line})`);
    }
    chk(dead.length === 0, "كل دالة عامّة يُنادِيها شيء",
      dead.slice(0, 15).join(" · ") + (dead.length > 15 ? ` … و${dead.length - 15} غيرها` : ""));
  }

  /* --------------------------------------------- ④ المعرّفات المطلوبة */
  console.log("\n▸ كل عنصرٍ يُطلَب بـgetElementById له أثر في الملف");
  {
    const ids = new Set();
    const re = /getElementById\(\s*(?:"([^"]+)"|'([^']+)')/g;
    let m;
    while ((m = re.exec(HTML))) ids.add(m[1] ?? m[2]);
    const ghosts = [...ids].filter((id) =>
      !HTML.includes(`id="${id}"`) && !HTML.includes(`id='${id}'`) &&
      (HTML.match(new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length <= 1);
    chk(ghosts.length === 0, `${ids.size} معرّفًا مطلوبًا — لكلّها أثر (ساكنًا أو ديناميًّا)`,
      ghosts.join(" · "));
  }

  /* ------------------------------------- ⑤ العربي مقابل أنواع الخادم */
  console.log("\n▸ كل قيمة عربية لها مقابل في نوع الخادم");
  {
    const pairs = [
      ["NOTE_STATUS_DB", "note_status"],
      ["ATT_STATE_DB", "att_state"],
      ["GRADE_KIND_DB", "grade_kind"],
    ];
    let checked = 0;
    for (const [varName, type] of pairs) {
      const map = clientMap(varName);
      const allowed = enumValues(type);
      if (!map || !allowed) continue;             // غير موجود ⇒ ليس خطأً
      checked += map.length;
      const orphan = map.filter((p) => !allowed.includes(p.val));
      chk(orphan.length === 0,
        `${varName}: قيمه كلّها في نوع الخادم ${type}`,
        orphan.map((p) => `${p.key}→${p.val}`).join(" · "));
    }
    chk(checked > 0, `فُحصت ${checked} قيمة عربية مقابل أنواع الخادم`,
      "لم تُطبَّق أيّ خريطة — تحقّق من أسماء المتغيّرات");
  }

  /* ------------------------------------------------------------ الحصيلة */
  console.log("\n" + "─".repeat(64));
  console.log(`__EDUVIA_SUITE_DONE__ ok=${pass} fail=${failures.length}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m\x1b[1m✅ نجح التدقيق الساكن — ${pass} تأكيدًا\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m❌ ${failures.length} خللًا من ${pass + failures.length}\x1b[0m`);
  failures.forEach((f) => console.log(`   · ${f}`));
  console.log();
  process.exit(1);
}

main();
