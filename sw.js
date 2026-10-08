/* ============================================================================
   EDUVIA — Service Worker (منصّة المدرسة)
   الملف: sw.js

   الاستراتيجية:
     · التنقّل وصفحات HTML  → الشبكة أولًا. تصل التحديثات فورًا، ويسعف الكاش
                              عند انقطاع الشبكة. (لو عكسناها لَبقي المستخدم
                              على نسخة قديمة أبدًا.)
     · الأصول الثابتة        → الكاش أولًا مع تحديث خلفي. الأيقونات لا تتغيّر.
     · أي طلب غير GET        → لا يُعترَض إطلاقًا.

   الأثر: المنصّة **تُفتح وتعمل بلا شبكة** — وهذا هو البند رقم ① في التقرير
   (الدرس الفنلدي 3.4: موبايل أولًا، محتمِل للانقطاع)، مع أن الكتابة نفسها
   محفوظة في localStorage أصلًا.
============================================================================ */

const CACHE = "eduvia-school-v3";
const ASSETS = [
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      /* addAll يفشل كليًا إن غاب ملفّ واحد — نخزّن كلًّا على حدة بدلًا من ذلك */
      .then((c) => Promise.all(ASSETS.map((a) => c.add(a).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  /* لا نتدخّل في طلبات الخادم (Supabase) — المزامنة لها منطقها الخاصّ في التطبيق */
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const accept = req.headers.get("accept") || "";
  const isDoc = req.mode === "navigate" || accept.includes("text/html");

  if (isDoc) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((r) => r || caches.match("./index.html"))
        )
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          })
          .catch(() => caches.match("./index.html"))
    )
  );
});
