#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — تشغيل كل الاختبارات
 *  الملف: tests/run-all.js
 *
 *    node tests/run-all.js
 *
 *  يشغّل:
 *    ① boot.test.js  — إقلاع المنصّة كاملةً في بيئة مصطنعة   (بلا متطلّبات)
 *    ② sync.test.js  — الطابور والمزامنة والمصادقة           (بلا متطلّبات)
 *    ③ rls.test.js   — الصلاحيات على PostgreSQL حقيقي        (يحتاج pg + قاعدة)
 *
 *  الاختبار ③ يُتخطّى تلقائيًا إن لم يكن DATABASE_URL مضبوطًا — فلا يفشل
 *  المشروع لأجل بيئة ناقصة، لكنه **يقول** إنه تُخطّي (لا صمت).
 * ==========================================================================*/
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const DIR = __dirname;
const suites = [
  { file: "boot.test.js", name: "الإقلاع", need: null },
  { file: "sync.test.js", name: "المزامنة والمصادقة", need: null },
  {
    file: "rls.test.js",
    name: "صلاحيات RLS (PostgreSQL)",
    need: "DATABASE_URL",
    hint: "اضبط DATABASE_URL وشغّل npm i pg لتشغيله",
  },
];

const results = [];

for (const s of suites) {
  console.log(`\n\x1b[1m━━━ ${s.name} ━━━\x1b[0m`);
  if (s.need && !process.env[s.need]) {
    console.log(`\x1b[33m⚠️  تُخطّي: ${s.need} غير مضبوط — ${s.hint}\x1b[0m`);
    results.push({ ...s, status: "skip" });
    continue;
  }
  const r = spawnSync(process.execPath, [path.join(DIR, s.file)], { stdio: "inherit" });
  results.push({ ...s, status: r.status === 0 ? "pass" : "fail" });
}

console.log("\n" + "═".repeat(64));
console.log("\x1b[1mالحصيلة\x1b[0m");
for (const r of results) {
  const mark = r.status === "pass" ? "\x1b[32m✅ نجح\x1b[0m"
             : r.status === "fail" ? "\x1b[31m❌ فشل\x1b[0m"
             : "\x1b[33m⚠️  تُخطّي\x1b[0m";
  console.log(`  ${mark}  ${r.name}`);
}

const failed = results.filter((r) => r.status === "fail").length;
const skipped = results.filter((r) => r.status === "skip").length;
console.log("═".repeat(64));
if (failed) {
  console.log(`\x1b[31m\x1b[1m${failed} مجموعة فشلت.\x1b[0m\n`);
  process.exit(1);
}
if (skipped) console.log(`\x1b[33m(تُخطّيت ${skipped} مجموعة — راجع الملاحظة أعلاه.)\x1b[0m`);
console.log("\x1b[32m\x1b[1mكل ما شُغِّل نجح.\x1b[0m\n");
