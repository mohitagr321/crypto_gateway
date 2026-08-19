/**
 * User-Agent -> something a human can recognise, for the login-approval email.
 *
 * WHY THIS IS HAND-WRITTEN RATHER THAN A DEPENDENCY. The job here is not device
 * fingerprinting or analytics; it is one sentence in an email that a merchant
 * reads and answers "yes, that's my laptop" or "no it isn't". That needs the
 * browser, the operating system and whether it is a phone — and needs to be
 * RIGHT for the handful of engines that account for essentially all real
 * traffic. A full UA database buys long-tail accuracy this does not need, at
 * the cost of a dependency on the auth path.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: guess. An unrecognised string yields
 * "Unknown browser", never a wrong-but-plausible name. The whole value of the
 * email is that the reader can trust what it says, and a confident wrong answer
 * ("Chrome on Windows" for something that was neither) is worse than an honest
 * blank — it would train someone to approve an attacker's session.
 *
 * ORDER IS LOAD-BEARING throughout. Every one of these browsers lies about
 * being the others: Edge's UA contains "Chrome" AND "Safari", Chrome's contains
 * "Safari", Opera's contains both plus "Chrome". So the checks run from the
 * most specific token to the least, and the first match wins. Reordering them
 * silently relabels a large share of real traffic.
 */

export interface DeviceInfo {
  /** "Chrome 141 on macOS" — the line the email leads with. */
  label: string;
  kind: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  browser: string;
  os: string;
}

/** First capture group of the first pattern that matches, else null. */
function firstMatch(ua: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = ua.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Major version only. "141.0.7390.55" -> "141". A point release is noise here. */
function major(version: string | null): string {
  if (!version) return '';
  const m = version.match(/^(\d+)/);
  return m ? m[1] : '';
}

function detectBrowser(ua: string): string {
  // Most specific first — see the ordering note above.
  const table: [RegExp, string][] = [
    [/\bEdg(?:iOS|A|)\/([\d.]+)/, 'Edge'],
    [/\bOPR\/([\d.]+)/, 'Opera'],
    [/\bOpera\/([\d.]+)/, 'Opera'],
    [/\bSamsungBrowser\/([\d.]+)/, 'Samsung Internet'],
    [/\bVivaldi\/([\d.]+)/, 'Vivaldi'],
    [/\bBrave\/([\d.]+)/, 'Brave'],
    [/\bFxiOS\/([\d.]+)/, 'Firefox'],
    [/\bFirefox\/([\d.]+)/, 'Firefox'],
    [/\bCriOS\/([\d.]+)/, 'Chrome'],
    [/\bChrome\/([\d.]+)/, 'Chrome'],
    // Safari LAST of the engines, and matched on Version/ rather than on
    // Safari/: every WebKit-derived browser above carries a `Safari/` token, so
    // testing for it earlier would label most of them "Safari". `Version/` is
    // the token real Safari uses for its own release number.
    [/\bVersion\/([\d.]+).*\bSafari\//, 'Safari'],
  ];

  for (const [re, name] of table) {
    const m = ua.match(re);
    if (m) {
      const v = major(m[1]);
      return v ? `${name} ${v}` : name;
    }
  }
  // A bare `Safari/` with no `Version/` is usually an embedded web view — an
  // in-app browser inside a native application. Worth saying, because "I opened
  // it from a link in WhatsApp" is a normal explanation and "I did not" is a
  // very abnormal one.
  if (/\bSafari\//.test(ua) && /\bAppleWebKit\//.test(ua)) return 'In-app browser';
  return 'Unknown browser';
}

function detectOs(ua: string): string {
  if (/\bWindows NT 10\.0/.test(ua)) {
    // Windows 11 is indistinguishable from 10 in the classic UA string —
    // Microsoft froze it at 10.0 — so this says the honest thing rather than
    // guessing between them.
    return 'Windows 10 or 11';
  }
  if (/\bWindows NT 6\.3/.test(ua)) return 'Windows 8.1';
  if (/\bWindows NT 6\.1/.test(ua)) return 'Windows 7';
  if (/\bWindows/.test(ua)) return 'Windows';

  // iPadOS 13+ reports itself as "Macintosh" to get desktop pages. The tell is
  // that it is a touch device, which the platform exposes as multi-touch — not
  // visible in the UA, so an iPad may legitimately read as macOS here. Checked
  // before macOS so the explicit iPad token still wins when it is present.
  if (/\biPad\b/.test(ua)) {
    const v = firstMatch(ua, [/\bOS (\d+[_\d]*)/]);
    return v ? `iPadOS ${v.replace(/_/g, '.')}` : 'iPadOS';
  }
  if (/\biPhone\b|\biPod\b/.test(ua)) {
    const v = firstMatch(ua, [/\bOS (\d+[_\d]*)/]);
    return v ? `iOS ${v.replace(/_/g, '.')}` : 'iOS';
  }
  if (/\bAndroid\b/.test(ua)) {
    const v = firstMatch(ua, [/\bAndroid (\d+(?:\.\d+)?)/]);
    return v ? `Android ${v}` : 'Android';
  }
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) {
    const v = firstMatch(ua, [/\bMac OS X (\d+[_\d]*)/]);
    // Apple caps the reported version at 10.15.7 for privacy, so a real
    // Sonoma/Sequoia machine says "10.15.7". Printing that would be worse than
    // useless — it looks like an ancient OS. The bare name is the truthful
    // answer available.
    if (!v || v.startsWith('10_15') || v.startsWith('10.15')) return 'macOS';
    return `macOS ${v.replace(/_/g, '.')}`;
  }
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
  if (/\bLinux\b/.test(ua)) return 'Linux';
  return 'Unknown OS';
}

function detectKind(ua: string): DeviceInfo['kind'] {
  if (/\biPad\b|\bTablet\b/.test(ua)) return 'tablet';
  // "Android" WITHOUT "Mobile" is Android's own convention for a tablet.
  if (/\bAndroid\b/.test(ua) && !/\bMobile\b/.test(ua)) return 'tablet';
  if (/\bMobi|\biPhone\b|\biPod\b|\bAndroid\b|\bWindows Phone\b/.test(ua)) return 'mobile';
  if (/\bWindows\b|\bMac OS X\b|\bMacintosh\b|\bCrOS\b|\bLinux\b/.test(ua)) return 'desktop';
  return 'unknown';
}

export function parseUserAgent(raw: string | undefined | null): DeviceInfo {
  const ua = (raw ?? '').trim();
  if (!ua) {
    return {
      label: 'Unrecognised device',
      kind: 'unknown',
      browser: 'Unknown browser',
      os: 'Unknown OS',
    };
  }
  const browser = detectBrowser(ua);
  const os = detectOs(ua);
  const kind = detectKind(ua);
  return { label: `${browser} on ${os}`, kind, browser, os };
}

/**
 * The IP as it should appear in an email.
 *
 * Express hands back IPv4-mapped IPv6 for a v4 client behind a proxy
 * ("::ffff:203.0.113.9"), which is correct and unreadable. The mapping prefix is
 * stripped; nothing else is rewritten, because this string may end up in an
 * abuse report and it has to be the address that actually connected.
 *
 * A loopback address is named rather than printed: "127.0.0.1" in a security
 * email reads as a broken system, where "this server" is the truth — it is what
 * a local development sign-in or a same-host proxy looks like.
 */
export function formatIp(ip: string | undefined | null): string {
  if (!ip) return 'Unknown';
  const clean = ip.replace(/^::ffff:/i, '');
  if (clean === '::1' || clean === '127.0.0.1') return 'this server (local)';
  return clean;
}
