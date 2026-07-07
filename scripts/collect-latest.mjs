import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const configPath = path.join(rootDir, 'config', 'sources.json');
const dataDir = path.join(rootDir, 'data');
const latestPath = path.join(dataDir, 'latest.json');
const logPath = path.join(dataDir, 'update-log.json');

const DEFAULT_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const DEFAULT_MAX_ITEMS = Number(process.env.MAX_ITEMS || 24);
const USER_AGENT = process.env.USER_AGENT || 'DeltaForceS10SiteBot/1.0 (+https://github.com/)';

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripCdata(value) {
  return String(value || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function textFromHtml(value) {
  return normalizeSpace(
    decodeEntities(stripCdata(value))
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

function firstTag(block, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = block.match(pattern);
  return match ? textFromHtml(match[1]) : '';
}

function firstAttr(block, tag, attr) {
  const pattern = new RegExp(`<${tag}\\b[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, 'i');
  const match = block.match(pattern);
  return match ? decodeEntities(match[1]) : '';
}

function absoluteUrl(value, baseUrl) {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return '';
  }
}

function safeIsoDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function summarize(value, maxLength = 180) {
  const text = textFromHtml(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        'accept': 'application/rss+xml, application/atom+xml, application/json, text/html;q=0.9, */*;q=0.8'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseRss(xml, source) {
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)
  ].map((match) => match[0]);

  return blocks.map((block) => {
    const title = firstTag(block, 'title');
    const link = absoluteUrl(firstTag(block, 'link') || firstAttr(block, 'link', 'href'), source.url);
    const publishedAt = firstTag(block, 'pubDate') || firstTag(block, 'published') || firstTag(block, 'updated');
    const summary = summarize(firstTag(block, 'description') || firstTag(block, 'summary') || firstTag(block, 'content:encoded'));
    return {
      title,
      url: link,
      source: source.name,
      sourceUrl: source.url,
      publishedAt: safeIsoDate(publishedAt),
      summary,
      fetchedAt: new Date().toISOString()
    };
  }).filter((item) => item.title && item.url);
}

function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<meta\\b(?=[^>]*(?:name|property)=["']${escaped}["'])[^>]*\\scontent=["']([^"']+)["'][^>]*>`, 'i');
  const match = html.match(pattern);
  return match ? decodeEntities(match[1]) : '';
}

function parseHtml(html, source) {
  const title = firstTag(html, 'title') || firstAttr(html, 'meta', 'title');
  const summary =
    metaContent(html, 'description') ||
    metaContent(html, 'og:description') ||
    '';
  const publishedAt =
    metaContent(html, 'article:published_time') ||
    firstAttr(html, 'time', 'datetime') ||
    '';
  return [{
    title,
    url: source.url,
    source: source.name,
    sourceUrl: source.url,
    publishedAt: safeIsoDate(publishedAt),
    summary: summarize(summary || '点击查看最新页面内容。'),
    fetchedAt: new Date().toISOString()
  }].filter((item) => item.title);
}

function getByPath(obj, dottedPath) {
  return String(dottedPath || '').split('.').filter(Boolean).reduce((acc, key) => acc?.[key], obj);
}

function parseJson(text, source) {
  const payload = JSON.parse(text);
  const rows = source.itemsPath ? getByPath(payload, source.itemsPath) : payload.items || payload.data || payload;
  if (!Array.isArray(rows)) return [];
  const map = source.map || {};
  return rows.map((row) => ({
    title: normalizeSpace(getByPath(row, map.title || 'title')),
    url: absoluteUrl(getByPath(row, map.url || 'url'), source.url),
    source: source.name,
    sourceUrl: source.url,
    publishedAt: safeIsoDate(getByPath(row, map.publishedAt || 'publishedAt') || getByPath(row, 'date') || ''),
    summary: summarize(getByPath(row, map.summary || 'summary') || getByPath(row, 'description') || ''),
    fetchedAt: new Date().toISOString()
  })).filter((item) => item.title && item.url);
}

async function loadConfig() {
  if (process.env.LATEST_SOURCES_JSON) {
    return JSON.parse(process.env.LATEST_SOURCES_JSON);
  }
  return JSON.parse(await readFile(configPath, 'utf8'));
}

function uniqueItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url || item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function collectSource(source) {
  if (!source.url) return [];
  const text = await fetchText(source.url);
  if (source.type === 'json') return parseJson(text, source);
  if (source.type === 'html') return parseHtml(text, source);
  return parseRss(text, source);
}

async function main() {
  const config = await loadConfig();
  const maxItems = Number(config.maxItems || DEFAULT_MAX_ITEMS);
  const sources = (config.sources || []).filter((source) => source.enabled !== false && source.url);
  const ok = [];
  const failed = [];
  const collected = [];

  for (const source of sources) {
    try {
      const items = await collectSource(source);
      ok.push({ name: source.name, url: source.url, type: source.type || 'rss', count: items.length });
      collected.push(...items);
    } catch (error) {
      failed.push({ name: source.name, url: source.url, message: error.message });
    }
  }

  const items = uniqueItems(collected)
    .sort((a, b) => new Date(b.publishedAt || b.fetchedAt) - new Date(a.publishedAt || a.fetchedAt))
    .slice(0, maxItems);

  const generatedAt = new Date().toISOString();
  await mkdir(dataDir, { recursive: true });
  await writeFile(latestPath, `${JSON.stringify({
    generatedAt,
    sources: sources.map(({ name, type = 'rss', url }) => ({ name, type, url })),
    items
  }, null, 2)}\n`, 'utf8');
  await writeFile(logPath, `${JSON.stringify({ generatedAt, ok, failed }, null, 2)}\n`, 'utf8');

  console.log(`Collected ${items.length} item(s) from ${ok.length}/${sources.length} source(s).`);
  if (failed.length) console.warn(`Failed source(s): ${failed.map((f) => f.name).join(', ')}`);
  if (!items.length && process.env.FAIL_ON_NO_ITEMS === '1') {
    throw new Error('No latest items were collected.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
