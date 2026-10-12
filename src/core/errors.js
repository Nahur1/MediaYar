'use strict';
/** Error types + translation of common ffmpeg failures into short Persian messages (platform-neutral). */

class FFmpegError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'FFmpegError';
    this.details = details || '';
  }
}

class AbortError extends Error {
  constructor() {
    super('canceled');
    this.name = 'AbortError';
  }
}

const RULES = [
  [/No space left on device|QuotaExceeded/i, 'فضای خالی دیسک کافی نیست.'],
  [/Cannot enlarge memory|Out of memory|memory access out of bounds|Array buffer allocation failed/i, 'حافظه‌ی مرورگر برای این فایل کافی نیست؛ فایل کوچک‌تر یا رزولوشن پایین‌تر را امتحان کنید.'],
  [/Permission denied|Access is denied/i, 'اجازه‌ی نوشتن در پوشه‌ی خروجی وجود ندارد.'],
  [/Invalid data found when processing input|moov atom not found/i, 'فایل ورودی خراب است یا به‌طور کامل دانلود نشده.'],
  [/does not contain any stream|matches no streams/i, 'فایل ورودی جریان صوتی/تصویری قابل استفاده ندارد.'],
  [/Could not find tag for codec|codec not currently supported in container|not supported by the muxer/i, 'این ترکیب کدک و فرمت پشتیبانی نمی‌شود؛ گزینه‌ی «حفظ کیفیت اصلی» را خاموش کنید.'],
  [/Unknown encoder/i, 'رمزگذار لازم در نسخه‌ی ffmpeg موجود نیست.'],
];

/** @param {string[]|string} lines */
function explain(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines || '');
  for (const [re, msg] of RULES) if (re.test(text)) return msg;
  return 'تبدیل با خطا متوقف شد.';
}

/** Shape any thrown value into `{error, details}` for the UI. */
function userError(e) {
  const known = e && (e.userFacing || e.name === 'FFmpegError' || e.name === 'PlanError');
  return { error: known ? e.message : 'خطای غیرمنتظره رخ داد.', details: e && (e.details || e.message) };
}

module.exports = { FFmpegError, AbortError, explain, userError };
