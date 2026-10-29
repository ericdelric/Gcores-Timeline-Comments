/*
 * Pure helpers for the GCORES timestamped-comment markers.
 *
 * Kept deliberately DOM-free: the content script uses these functions, and
 * Node can require() this file directly for tests.
 */
(function initGtcLib(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GTC = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildGtcLib() {
  'use strict';

  const MAX_REASONABLE_SECONDS = 24 * 60 * 60;

  function finiteNonNegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }

  /**
   * Parse a timestamp in one of the shapes GCORES / human comments use.
   * Returns seconds, or null for anything invalid.
   *
   * Accepted: 90, "90", "1:30", "01:02:03", "1小时2分3秒",
   *           "2分3秒", "90秒", "1h2m3s", "1 hr 2 min 3 sec".
   */
  function parseTimestamp(value) {
    if (typeof value === 'number') {
      const numeric = finiteNonNegative(value);
      return numeric !== null && numeric <= MAX_REASONABLE_SECONDS ? numeric : null;
    }
    if (typeof value !== 'string') return null;

    const text = value.trim();
    if (!text) return null;

    if (/^\d+(?:\.\d+)?$/.test(text)) {
      const numeric = Number(text);
      return Number.isFinite(numeric) && numeric <= MAX_REASONABLE_SECONDS ? numeric : null;
    }

    const clock = text.match(/^(\d{1,4}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/);
    if (clock) {
      const first = Number(clock[1]);
      const second = Number(clock[2]);
      if (!Number.isFinite(first) || !Number.isFinite(second)) return null;

      if (clock[3] === undefined) {
        // "84:42" is minutes:seconds, matching the GCORES player convention.
        if (second > 59) return null;
        const total = first * 60 + second;
        return total <= MAX_REASONABLE_SECONDS ? total : null;
      }

      const third = Number(clock[3]);
      if (second > 59 || third > 59) return null;
      const total = first * 3600 + second * 60 + third;
      return total <= MAX_REASONABLE_SECONDS ? total : null;
    }

    const unitMatch = text.match(
      /^(?:(\d+(?:\.\d+)?)\s*(?:个)?(?:小时|钟头|时|h|hr|hrs))?\s*(?:(\d+(?:\.\d+)?)\s*(?:分钟|分|min|mins|m))?\s*(?:(\d+(?:\.\d+)?)\s*(?:秒钟|秒|sec|secs|s))?$/i
    );
    if (unitMatch && (unitMatch[1] || unitMatch[2] || unitMatch[3])) {
      const hours = unitMatch[1] ? Number(unitMatch[1]) : 0;
      const minutes = unitMatch[2] ? Number(unitMatch[2]) : 0;
      const seconds = unitMatch[3] ? Number(unitMatch[3]) : 0;
      if (![hours, minutes, seconds].every(Number.isFinite)) return null;
      const total = hours * 3600 + minutes * 60 + seconds;
      return total <= MAX_REASONABLE_SECONDS ? total : null;
    }

    return null;
  }

  function pad2(value) {
    return String(Math.floor(value)).padStart(2, '0');
  }

  /** 27 -> "0:27", 2675 -> "44:35", 5082 -> "1:24:42" */
  function formatTime(value) {
    const numeric = parseTimestamp(value);
    if (numeric === null) return '--:--';
    const total = Math.round(numeric);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
    return `${minutes}:${pad2(seconds)}`;
  }

  /** Longer, unambiguous label for screen readers. */
  function formatTimeLong(value) {
    const numeric = parseTimestamp(value);
    if (numeric === null) return '未知时间';
    const total = Math.round(numeric);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const parts = [];
    if (hours) parts.push(`${hours} 小时`);
    if (minutes) parts.push(`${minutes} 分`);
    if (seconds || parts.length === 0) parts.push(`${seconds} 秒`);
    return parts.join(' ');
  }

  function decodeEntities(text) {
    const named = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: ' ',
      hellip: '…',
      mdash: '—',
      ndash: '–',
      middot: '·',
      laquo: '«',
      raquo: '»',
      ldquo: '“',
      rdquo: '”',
      lsquo: '‘',
      rsquo: '’',
    };

    return text
      .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
        const code = parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      })
      .replace(/&#(\d+);/g, (match, decimal) => {
        const code = parseInt(decimal, 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      })
      .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => {
        const key = String(name).toLowerCase();
        return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
      });
  }

  /**
   * Convert API HTML-ish text into safe, readable plain text.
   * The UI always assigns the result via textContent, never innerHTML.
   */
  function toPlainText(value) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/(?:p|div|li)>/gi, '\n');
    text = text.replace(/<[^>]*>/g, '');
    text = decodeEntities(text);
    text = text.replace(/\u00a0/g, ' ');
    return text
      .replace(/\r/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  /**
   * Timestamped comments often start with their own "44:35" prefix.
   * Remove it so the marker tooltip does not show the time twice.
   */
  function stripTimestampPrefix(value) {
    const text = String(value || '');
    const stripped = text
      .replace(
        /^\s*(?:\d{1,3}:)?\d{1,2}:\d{2}(?:\.\d+)?\s*(?:[-–—:：|·]\s*)?/,
        ''
      )
      .replace(
        /^\s*(?:(?:\d+(?:\.\d+)?)\s*(?:小时|钟头|时|h|hr|hrs)\s*)?(?:(?:\d+(?:\.\d+)?)\s*(?:分钟|分|min|mins|m)\s*)?(?:(?:\d+(?:\.\d+)?)\s*(?:秒钟|秒|sec|secs|s))\s*(?:[-–—:：|·]\s*)?/i,
        ''
      )
      .trim();
    return stripped || text.trim();
  }

  function extractDuration(payload) {
    if (!payload || typeof payload !== 'object') return 0;
    const candidates = [];
    if (payload.data && payload.data.attributes) {
      candidates.push(payload.data.attributes.duration);
    }
    for (const item of Array.isArray(payload.included) ? payload.included : []) {
      if (item && item.type === 'medias' && item.attributes) {
        candidates.push(item.attributes.duration);
      }
    }
    for (const value of candidates) {
      const numeric = typeof value === 'string' ? Number(value) : value;
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
    return 0;
  }

  function extractTimelineEntries(payload) {
    if (!payload || !Array.isArray(payload.included)) return [];

    const included = payload.included;
    const media = included.find((item) => item && item.type === 'medias');
    const relationshipIds = new Set();
    const timelineRelationship = media && media.relationships && media.relationships.timelines;
    if (timelineRelationship && Array.isArray(timelineRelationship.data)) {
      for (const item of timelineRelationship.data) {
        if (item && item.id !== undefined) relationshipIds.add(String(item.id));
      }
    }

    let timelines = included.filter((item) => item && item.type === 'timelines');
    if (relationshipIds.size > 0) {
      timelines = timelines.filter((item) => relationshipIds.has(String(item.id)));
    }

    const entries = [];
    for (const item of timelines) {
      const attrs = item.attributes || {};
      const at = parseTimestamp(attrs.at);
      if (at === null) continue;
      const title = toPlainText(attrs.title);
      const content = toPlainText(attrs.content);
      entries.push({
        id: String(item.id),
        kind: 'timeline',
        at,
        title: title || '时间轴',
        content,
        author: '',
        commentsCount: Number(attrs['comments-count']) || 0,
        createdAt: attrs['created-at'] || '',
      });
    }
    return entries;
  }

  function extractTimestampedComments(payload) {
    if (!payload || !Array.isArray(payload.data)) return [];

    const users = new Map();
    for (const item of Array.isArray(payload.included) ? payload.included : []) {
      if (item && item.type === 'users') {
        users.set(String(item.id), item.attributes || {});
      }
    }

    const entries = [];
    for (const item of payload.data) {
      if (!item || item.type !== 'comments' || !item.attributes) continue;
      const attrs = item.attributes;
      const at = parseTimestamp(attrs['radio-timestamp']);
      if (at === null) continue;

      const userRef =
        item.relationships && item.relationships.user && item.relationships.user.data;
      const user = userRef ? users.get(String(userRef.id)) || {} : {};
      const author = toPlainText(user.nickname || user.name || '');
      const rawBody = toPlainText(attrs.body);
      const content = stripTimestampPrefix(rawBody);

      entries.push({
        id: String(item.id),
        kind: 'comment',
        at,
        title: '',
        content,
        author,
        commentsCount: 0,
        createdAt: attrs['created-at'] || '',
      });
    }
    return entries;
  }

  function mergeEntries(entries, duration) {
    const seen = new Set();
    const result = [];
    const max = Number.isFinite(duration) && duration > 0 ? duration + 0.25 : Infinity;

    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || (entry.kind !== 'timeline' && entry.kind !== 'comment')) continue;
      const at = parseTimestamp(entry.at);
      if (at === null || at > max) continue;
      const key = `${entry.kind}:${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...entry, at });
    }

    result.sort((left, right) => {
      if (left.at !== right.at) return left.at - right.at;
      return String(left.title || left.author || '').localeCompare(
        String(right.title || right.author || '')
      );
    });
    return result;
  }

  /**
   * Group markers that would be closer than `thresholdPx` on the current
   * timeline. Returns clusters in playback order.
   */
  function groupEntries(entries, duration, width, thresholdPx) {
    const sorted = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && Number.isFinite(entry.at))
      .slice()
      .sort((left, right) => left.at - right.at);

    const usableWidth = Number.isFinite(width) && width > 0;
    const usableDuration = Number.isFinite(duration) && duration > 0;
    const threshold = Number.isFinite(thresholdPx) ? Math.max(0, thresholdPx) : 12;
    const canUsePixels = usableWidth && usableDuration && threshold > 0;

    const clusters = [];
    for (const entry of sorted) {
      const last = clusters[clusters.length - 1];
      const sameMoment = last && Math.abs(entry.at - last.at) < 0.001;
      const tooClose =
        last &&
        canUsePixels &&
        ((entry.at - last.at) / duration) * width < threshold;
      if (last && (sameMoment || tooClose)) {
        last.entries.push(entry);
      } else {
        clusters.push({ at: entry.at, entries: [entry] });
      }
    }
    return clusters;
  }

  function excerpt(value, limit) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const max = Number.isFinite(limit) ? limit : 90;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function entryAccessibleText(entry) {
    if (entry.kind === 'timeline') {
      return [entry.title, excerpt(entry.content, 100)].filter(Boolean).join('。');
    }
    const author = entry.author ? `@${entry.author}：` : '';
    return `${author}${excerpt(entry.content, 120)}`;
  }

  function trimEndingPunctuation(value) {
    return String(value || '').replace(/[。！？!?；;，,\s]+$/g, '');
  }

  function clusterAccessibleLabel(cluster) {
    const count = cluster.entries.length;
    if (count === 1) {
      const entry = cluster.entries[0];
      const summary = trimEndingPunctuation(entryAccessibleText(entry));
      return `${formatTimeLong(cluster.at)}，${
        entry.kind === 'comment' ? '评论' : '时间轴'
      }：${summary}。按回车跳转到该时间。`;
    }

    const summary = cluster.entries
      .slice(0, 3)
      .map((entry) => {
        const short =
          entry.kind === 'timeline'
            ? entry.title
            : entry.author || excerpt(entry.content, 24);
        return `${formatTime(entry.at)} ${short || '评论'}`;
      })
      .join('；');
    const more = count > 3 ? `；还有 ${count - 3} 条` : '';
    return `${formatTimeLong(cluster.at)}附近共 ${count} 条：${summary}${more}。按回车跳转到最早一条。`;
  }

  return {
    parseTimestamp,
    formatTime,
    formatTimeLong,
    toPlainText,
    stripTimestampPrefix,
    extractDuration,
    extractTimelineEntries,
    extractTimestampedComments,
    mergeEntries,
    groupEntries,
    excerpt,
    entryAccessibleText,
    clusterAccessibleLabel,
  };
});
