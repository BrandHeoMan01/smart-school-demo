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
 *
 *  ⚠️ درسٌ دفعنا ثمنه فعلًا: الاعتماد على رمز الخروج وحده **يكذب**.
 *  اختبارٌ يموت في منتصفه — وعدٌ لا يُحلّ ⇒ لا مؤقّتات حيّة ⇒ ينفد حدث Node
 *  ويخرج بـ0 — يبدو «ناجحًا» وهو لم يُكمل عُشرَه. لذلك تطلب كل مجموعة علامة
 *  إتمام صريحة، ومن غابت علامته تُوصَف بـ«انقطع» لا بـ«نجح».
 * ==========================================================================*/
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const DIR = __dirname;
const DONE = /__EDUVIA_SUITE_DONE__ ok=(\d+) fail=(\d+)/;

const suites = [
  { file: "boot.test.js", name: "الإقلاع", need: null },
  { file: "static.test.js", name: "التدقيق الساكن للملفّ", need: null },
  { file: "sync.test.js", name: "المزامنة والمصادقة", need: null },
  {
    file: "rls.test.js",
    name: "صلاحيات RLS (PostgreSQL)",
    need: "DATABASE_URL",
    hint: "اضبط DATABASE_URL وشغّل npm i pg لتشغيله",
  },
];

/* يمكن إضافة مجموعات من سطر الأوامر. نستعملها لاختبار العدّاد نفسه:
     node tests/run-all.js tests/_scratch.js
   (اختبارُ الاختبار: مجموعة تخرج بـ0 بلا علامة إتمام يجب أن تُوصَف «انقطع».) */
for (const f of process.argv.slice(2)) {
  if (!f.startsWith("-")) suites.push({ file: f, name: f, need: null });
}

const results = [];

for (const s of suites) {
  console.log(`\n\x1b[1m━━━ ${s.name} ━━━\x1b[0m`);
  if (s.need && !process.env[s.need]) {
    console.log(`\x1b[33m⚠️  تُخطّي: ${s.need} غير مضبوط — ${s.hint}\x1b[0m`);
    results.push({ ...s, status: "skip" });
    continue;
  }

  const r = spawnSync(process.execPath, [path.join(DIR, s.file)], { encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  if (r.stderr) process.stderr.write(r.stderr);

  const m = !r.error && DONE.exec(r.stdout || "");
  const ok = m ? Number(m[1]) : 0;
  const fail = m ? Number(m[2]) : 0;
  const status = r.error ? "fail" : !m ? "cut" : r.status === 0 && fail === 0 ? "pass" : "fail";

  results.push({ ...s, status, ok, fail });

  if (status === "cut") {
    console.log("\x1b[31m⚠️  انقطع قبل النهاية — لم تُطبَع علامة الإتمام.\x1b[0m");
    console.log("\x1b[33m   السبب الغالب: وعدٌ لا يُحلّ (استدعاء شبكة أو مؤقّت مزيّف في بيئة الاختبار)\x1b[0m");
    console.log("\x1b[33m   فينفد حدث Node وتخرج العملية بـ0 وهي لم تُكمل. لا تعتبره نجاحًا.\x1b[0m");
  }
  if (r.error) console.log(`\x1b[31m   تعذّر التشغيل:\x1b[0m ${r.error.message}`);
}

/* ------------------------------------------------------------- الحصيلة */
console.log("\n" + "═".repeat(64));
console.log("\x1b[1mالحصيلة\x1b[0m");

let totalOk = 0, totalFail = 0;
for (const r of results) {
  if (r.status === "skip") {
    console.log(`  \x1b[33m⚠️  تُخطّي\x1b[0m  ${r.name}`);
    continue;
  }
  if (r.status === "pass") {
    totalOk += r.ok;
    console.log(`  \x1b[32m✅ نجح\x1b[0m   ${r.name}  \x1b[2m(${r.ok} تأكيدًا)\x1b[0m`);
  } else if (r.status === "cut") {
    totalFail++;
    console.log(`  \x1b[31m✂️  انقطع\x1b[0m  ${r.name}  \x1b[2m(بعد ${r.ok} تأكيدًا — لم يكتمل)\x1b[0m`);
  } else {
    totalFail++;
    totalOk += r.ok;
    console.log(`  \x1b[31m❌ فشل\x1b[0m   ${r.name}  \x1b[2m(${r.ok} نجح · ${r.fail} فشل)\x1b[0m`);
  }
}

const skipped = results.filter((r) => r.status === "skip").length;
console.log("═".repeat(64));
if (totalOk) console.log(`\x1b[1m${totalOk} تأكيدًا نجح\x1b[0m`);

if (totalFail) {
  console.log(`\x1b[31m\x1b[1m${totalFail} مجموعة لم تنجح.\x1b[0m\n`);
  process.exit(1);
}
if (skipped) console.log(`\x1b[33m(تُخطّيت ${skipped} مجموعة — راجع الملاحظة أعلاه.)\x1b[0m`);
console.log("\x1b[32m\x1b[1mكل ما شُغِّل نجح، وكل مجموعة بلغت نهايتها.\x1b[0m\n");
