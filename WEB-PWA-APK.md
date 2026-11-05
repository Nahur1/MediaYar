# مدیا یار — نسخه‌ی وب، PWA و APK

## انتشار نسخه‌ی وب
ابتدا `npm ci` و سپس `npm run build:web` را اجرا کنید. محتوای پوشه‌ی `dist/web` یک سایت کاملاً استاتیک است.
آن را روی هر میزبان **HTTPS** بگذارید (Netlify، Cloudflare Pages، GitHub Pages، Vercel یا هاست معمولی).
- سرور باید فایل `.wasm` را با نوع `application/wasm` بفرستد (فایل `.htaccess` و `_headers` آماده است).
- هیچ سرور یا API لازم نیست؛ همه‌ی پردازش در مرورگر کاربر انجام می‌شود و فایلی آپلود نمی‌شود.
- آزمایش محلی: `node scripts/serve-web.js dist/web 8080` و باز کردن `http://localhost:8080`.

## PWA
manifest، آیکن‌ها (۱۹۲، ۵۱۲ و maskable) و service worker آماده‌اند:
- بعد از اولین بار، برنامه **آفلاین** کار می‌کند (موتور FFmpeg حدود ۳۰ مگابایت یک‌بار دانلود و کش می‌شود).
- در Chrome/Edge دکمه‌ی «نصب برنامه» در نوار کناری ظاهر می‌شود.

## ساخت APK اندروید
### روش ۱ — Capacitor (پیشنهادی، فایل APK کامل و آفلاین)
```bash
npm ci
npm run build:android
# یا برای باز کردن پروژهٔ موجود در Android Studio:
npm run android:sync
npx cap open android
```
پروژهٔ واقعی اندروید در `android` موجود است. پیش‌نیازها: JDK 21، Android SDK Platform 36 و Build Tools 36.0.0؛ مسیر SDK را با `ANDROID_HOME` یا `android/local.properties` تنظیم کنید. Gradle Wrapper همراه پروژه است.

خروجی دستور ساخت: `builds/android/MediaYar-debug.apk`؛ این فایل با امضای توسعه قابل نصب مستقیم است. برای انتشار در فروشگاه باید کلید امضای انتشار خودتان را تنظیم کرده و release/AAB بسازید؛ کلید انتشار در پروژه ساخته یا ذخیره نشده است.

موتور پردازش همراه APK بسته‌بندی می‌شود و برای تبدیل به اینترنت نیاز ندارد. خروجی در کش خصوصی برنامه قرار می‌گیرد؛ دکمهٔ «ذخیره / اشتراک» آن را با افزونهٔ بومی Capacitor به برنامهٔ مقصد می‌فرستد. خروجی‌های مهم را پیش از بستن برنامه به محل دائمی منتقل کنید. ضبط صفحه در اندروید پشتیبانی نمی‌شود؛ دکمهٔ آن در WebView پنهان است.

### روش ۲ — TWA (Bubblewrap)، وقتی نسخه‌ی وب روی دامنه‌ی خودتان منتشر شده است
```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://YOUR-DOMAIN/manifest.webmanifest
bubblewrap build
```

## نکات فنی
- موتور وب: ffmpeg.wasm 0.12 (تک‌رشته‌ای؛ نسخه‌ی چندرشته‌ای در Chrome‌های جدید ناپایدار بود و کنار گذاشته شد).
- در وب، WEBM با VP8 ساخته می‌شود (رمزگذار VP9 نسخه‌ی wasm ناپایدار است) و AMR در دسترس نیست؛
  این‌ها خودکار از فهرست فرمت‌های نسخه‌ی وب حذف می‌شوند. نسخه‌ی دسکتاپ همه را دارد.
- سرعت پردازش در مرورگر کمتر از نسخه‌ی دسکتاپ است؛ برای فایل‌های خیلی بزرگ (چند گیگابایت) نسخه‌ی ویندوز مناسب‌تر است.

## Screen recording & saving on web / Android
- Screen recording uses `getDisplayMedia` + `MediaRecorder` (Chrome/Edge/Firefox desktop). Mobile
  browsers and Android WebViews don't offer screen capture, so the "ضبط صفحه" section hides itself
  there (`caps.screenRecord`). A native Android recorder would need a Capacitor plugin
  (MediaProjection) feeding the same `record` job.
- "Save as" uses the File System Access API (`showSaveFilePicker`) where available; elsewhere the
  user confirms a file name and the browser downloads it.
