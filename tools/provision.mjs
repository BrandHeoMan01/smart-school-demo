#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — إنشاء حسابات الدخول (بطاقة + رمز سري)
 *  الملف: tools/provision.mjs
 *
 *  لماذا سكربت ولا SQL؟ لأن كتابة كلمات السر مباشرةً في جدول auth.users
 *  **ليست مدعومة رسميًا** في Supabase وقد تنكسر مع أي تحديث. الطريق الصحيح
 *  هو Admin API بمفتاح service_role — وهو ما يفعله هذا السكربت.
 *
 *  الاستعمال:
 *    export SUPABASE_URL="https://xxxx.supabase.co"
 *    export SUPABASE_SERVICE_ROLE_KEY="eyJhbGci..."
 *    node tools/provision.mjs                 # كل التلاميذ + طاقم تجريبي
 *    node tools/provision.mjs --dry           # عرض بلا إنشاء
 *
 *  ⚠️ مفتاح service_role **يتجاوز كل سياسات RLS**. لا تضعْه أبدًا في ملف
 *     HTML ولا في متغيّر يبدأ بـ VITE_/NEXT_PUBLIC_. استعمله على جهازك فقط.
 *
 *  المخرَج: roster.csv — كشف البطاقات والأرقام السرّية لتوزيعه على التلميذات.
 * ==========================================================================*/

import { writeFileSync } from "node:fs";

const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.argv.includes("--dry");

/* الرمز السري: ٦ أرقام — طويل بما يكفي لسياسة Supabase الافتراضية، وقصير
   بما يكفي لتلميذة في الابتدائي. */
const PIN_LEN = 6;
const randomPin = () =>
  Array.from({ length: PIN_LEN }, () => Math.floor(Math.random() * 10)).join("");

/* "RF-0001" → "rf-0001@eduvia.local" — بريد اصطناعي لا يُرسَل إليه أبدًا،
   لكنه يسمح لـSupabase Auth أن يعمل بأصالته بلا مزوّد بريد. */
export const toEmail = (loginId) =>
  `${String(loginId).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-")}@eduvia.local`;

/* ------------------------------------------------------------------ HTTP */
async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* نصّ غير JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

/* ------------------------------------------------------- إنشاء مستخدم */
async function createUser(loginId, pin, meta) {
  const email = toEmail(loginId);
  const r = await api("/auth/v1/admin/users", {
    method: "POST",
    body: { email, password: pin, email_confirm: true, user_metadata: meta },
  });
  if (r.ok) return { id: r.json.id, created: true };
  // موجود سلفًا ⇒ نجلبه بدل أن نفشل
  if (r.status === 422 || r.status === 409) {
    const list = await api(`/auth/v1/admin/users?page=1&per_page=1000`);
    if (list.ok && Array.isArray(list.json?.users)) {
      const found = list.json.users.find((u) => u.email === email);
      if (found) return { id: found.id, created: false };
    }
  }
  throw new Error(`فشل إنشاء ${email}: ${r.status} ${r.text.slice(0, 160)}`);
}

async function upsertProfile(row) {
  const r = await api("/rest/v1/profiles?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: row,
  });
  if (!r.ok) throw new Error(`فشل حفظ الملفّ الشخصي ${row.login_id}: ${r.status} ${r.text.slice(0, 160)}`);
}

/* ---------------------------------------------------------------- البرنامج */
async function main() {
  if (!URL_BASE || !KEY) {
    console.error("✖ ينقص SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY.\n" +
                  "  راجِع SUPABASE-SETUP.md — الخطوة ٤.");
    process.exit(2);
  }
  console.log(`\n\x1b[1mEDUVIA — إنشاء الحسابات\x1b[0m  ${DRY ? "\x1b[33m[عرض فقط]\x1b[0m" : ""}\n`);

  // المؤسسة
  const schools = await api("/rest/v1/schools?select=id,name&limit=1");
  if (!schools.ok || !schools.json?.length) {
    console.error("✖ لا توجد مؤسسة. شغّل sql/001 ثم sql/003 في محرّر SQL أولًا.");
    process.exit(1);
  }
  const school = schools.json[0];
  console.log(`▸ المؤسسة: ${school.name}`);

  // التلاميذ
  const st = await api("/rest/v1/students?select=id,card_no,full_name,class_label&order=card_no");
  if (!st.ok) throw new Error(`فشل قراءة التلاميذ: ${st.text.slice(0, 160)}`);
  const students = st.json || [];
  console.log(`▸ التلاميذ: ${students.length}`);

  const roster = [["نوع الحساب", "مُعرِّف الدخول", "الاسم", "القسم", "الرمز السري"]];
  let made = 0, reused = 0;

  /* ---------------------------------------------- حسابات التلاميذ */
  for (const s of students) {
    const pin = randomPin();
    try {
      const { id, created } = DRY
        ? { id: "00000000-0000-0000-0000-000000000000", created: true }
        : await createUser(s.card_no, pin, { role: "student", name: s.full_name });
      created ? made++ : reused++;
      if (!DRY) {
        await upsertProfile({
          id, school_id: school.id, role: "student",
          display_name: s.full_name, login_id: s.card_no, student_id: s.id,
        });
      }
      roster.push(["تلميذة", s.card_no, s.full_name, s.class_label, pin]);
    } catch (e) {
      console.error(`  ✗ ${s.card_no} — ${e.message}`);
    }
  }

  /* ---------------------------------------------- حسابات الطواقم */
  const staffAccounts = [
    ["director",   "المديرة زهية",          "director"],
    ["supervisor", "الناظر كريم",            "supervisor"],
    ["reception",  "الأمانة",               "reception"],
    ["RF-T001",    "الأستاذة فاطمة الزهراء", "teacher"],
    ["inspector",  "المفتّش سعيد",           "inspector"],
    ["authority",  "مديرية التربية",         "authority"],
  ];
  for (const [loginId, name, role] of staffAccounts) {
    const pin = randomPin();
    try {
      const { id, created } = DRY
        ? { id: "00000000-0000-0000-0000-000000000000", created: true }
        : await createUser(loginId, pin, { role, name });
      created ? made++ : reused++;
      if (!DRY) {
        await upsertProfile({
          id, school_id: school.id, role,
          display_name: name, login_id: loginId,
        });
      }
      roster.push(["طاقم", loginId, name, role, pin]);
    } catch (e) {
      console.error(`  ✗ ${loginId} — ${e.message}`);
    }
  }

  /* ---------------------------------------------- كشف البطاقات */
  const csv = "﻿" + roster.map((r) => r.map((c) => `"${c}"`).join(",")).join("\r\n");
  writeFileSync("roster.csv", csv, "utf8");

  console.log(`\n✔ أُنشئ ${made} حسابًا · أُعيد استخدام ${reused}`);
  console.log(`✔ الكشف في roster.csv — \x1b[33m${DRY ? "عرض فقط، بلا أرقام حقيقية" : "وزّعه ثم احذفه"}\x1b[0m`);
  console.log(`\nملاحظة: الأرقام السرّية مُولَّدة عشوائيًا ولا تُخزَّن عندنا.
احتفظ بـroster.csv في مكان آمن ثم احذفه بعد طبع البطاقات.\n`);
}

main().catch((e) => { console.error(`\n✖ ${e.message}\n`); process.exit(1); });
