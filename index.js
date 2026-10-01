/* EchoMusic plugin: qqovo-music
 * QQ / 网易云 / 汽水 via music.qqovo.cn (md3Music DiscoveryApi port)
 */
const PLUGIN_SOURCE_PREFIX = 'qqovo';
const QQOVO_BASES = ['https://music.qqovo.cn', 'https://qqovo.top'];
const LYRIC_CACHE = new Map();
const PLAY_URL_CACHE = new Map();
const RESOLVE_HIT_CACHE = new Map(); // `${server}|${id}|${preference}` -> hit
const PREFETCH_INFLIGHT = new Map();
const QISHUI_FILES = new Map();
let qishuiServerOrigin = '';
const SESSION = { byBase: new Map() };
const LOCAL_FAV_STORAGE_KEY = 'qqovo-local-favorites';

const SOURCE_DEFS = [
  { id: 'qq', label: 'QQ 音乐', server: 'tencent', musicdl: 'qq' },
  { id: 'netease', label: '网易云', server: 'netease', musicdl: 'netease' },
  { id: 'qishui', label: '汽水', server: 'qishui', musicdl: 'soda' },
];

const MUSICDL_BASE = 'https://music.20262050.xyz';
const PLATFORM_HOT_ID = 'qqovo-platform-hot';

const VIEW_TABS = [
  { id: 'search', label: '搜索' },
  { id: 'fm', label: '漫游' },
  { id: 'charts', label: '排行榜' },
];

/** 对齐 md3Music fm_modes.dart / OpenMusic */
const FM_MODES = {
  qq: [{ value: 'DEFAULT', label: '猜你喜欢', description: 'QQ 音乐个性化推荐' }],
  netease: [
    { value: 'DEFAULT', label: '默认漫游', description: '综合听歌记录' },
    { value: 'FAMILIAR', label: '熟悉模式', description: '多推收藏与常听' },
    { value: 'EXPLORE', label: '探索模式', description: '多推新歌冷门' },
    { value: 'SCENE_RCMD:EXERCISE', label: '运动场景', description: '节奏明快' },
    { value: 'SCENE_RCMD:FOCUS', label: '专注场景', description: '适合工作学习' },
    { value: 'SCENE_RCMD:NIGHT_EMO', label: '深夜场景', description: '夜晚慢歌' },
    { value: 'aidj', label: 'AI DJ', description: 'AI 串烧混剪' },
  ],
  qishui: [
    { value: 'DEFAULT', label: '推荐模式', description: '综合听歌偏好' },
    { value: 'FAMILIAR', label: '熟悉模式', description: '熟悉或相似风格' },
    { value: 'FRESH', label: '新鲜模式', description: '没听过的新歌' },
    { value: 'SCENE_MODE_ID:2', label: '动感健身', description: '适合运动' },
    { value: 'SCENE_MODE_ID:3', label: 'Chill 放松', description: '舒缓放松' },
    { value: 'SCENE_MODE_ID:5', label: '快乐时光', description: '轻松明快' },
    { value: 'SCENE_MODE_ID:40', label: '夜晚', description: '夜间氛围' },
    { value: 'SCENE_MODE_ID:21', label: '治愈', description: '温柔舒缓' },
    { value: 'SCENE_MODE_ID:18', label: '小酒馆', description: '微醺氛围' },
  ],
};

const NETEASE_CHARTS = [
  { id: '3778678', name: '热歌榜' },
  { id: '19723756', name: '飙升榜' },
  { id: '3779629', name: '新歌榜' },
  { id: '2884035', name: '原创榜' },
  { id: '5453912201', name: '云音乐说唱榜' },
  { id: '2809513715', name: '欧美热歌榜' },
];

const serverOf = (sourceId) =>
  SOURCE_DEFS.find((s) => s.id === sourceId)?.server || 'tencent';

const musicdlSourceOf = (sourceId) =>
  SOURCE_DEFS.find((s) => s.id === sourceId)?.musicdl || 'qq';

const fmModesOf = (sourceId) => FM_MODES[sourceId] || FM_MODES.qq;

const fmMetingId = (mode, sourceId) => {
  const v = String(mode || 'DEFAULT').trim() || 'DEFAULT';
  if (sourceId === 'qq' || v === 'DEFAULT') return '';
  const hit = fmModesOf(sourceId).some((m) => m.value === v);
  return hit ? v : '';
};

const sourceIdFromApi = (apiSource) => {
  const s = String(apiSource || '').trim().toLowerCase();
  if (s === 'tencent' || s === 'qq') return 'qq';
  if (s === 'qishui' || s === 'soda') return 'qishui';
  if (s === 'netease') return 'netease';
  return 'qq';
};

const uuid = () => {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const httpsify = (url) => {
  let u = String(url || '').trim();
  if (u.startsWith('//')) u = `https:${u}`;
  if (u.startsWith('http://')) u = `https://${u.slice(7)}`;
  return u;
};

const headerLookup = (headers, name) => {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    try {
      const v = headers.get(name);
      if (v != null && v !== '') return v;
    } catch {
      /* ignore */
    }
  }
  const want = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) return v;
  }
  return undefined;
};

/** 从各类响应头袋提取 Set-Cookie name=value（EchoMusic net.request 常丢 Cookie，需兼容 fetch/getSetCookie/rawHeaders）。 */
const parseSetCookie = (headers) => {
  const pairs = [];
  const pushLine = (line) => {
    const part = String(line || '').split(';')[0].trim();
    if (part.includes('=')) pairs.push(part);
  };
  if (!headers) return pairs;

  if (typeof headers.getSetCookie === 'function') {
    try {
      for (const line of headers.getSetCookie() || []) pushLine(line);
      if (pairs.length) return pairs;
    } catch {
      /* ignore */
    }
  }

  const raw =
    headerLookup(headers, 'set-cookie') ??
    headers.setCookie ??
    headers.cookies ??
    headers['Set-Cookie'];
  if (Array.isArray(raw)) {
    for (const line of raw) pushLine(line);
  } else if (typeof raw === 'string' && raw.trim()) {
    // 多枚 Cookie 偶发被逗号拼接；按「下一枚 name=」边界拆
    const parts = raw.includes(',') ? raw.split(/,(?=\s*[^;,\s]+=)/) : [raw];
    for (const line of parts) pushLine(line);
  }

  const rawHeaders = headers.rawHeaders || headers.raw;
  if (Array.isArray(rawHeaders)) {
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
      if (String(rawHeaders[i]).toLowerCase() === 'set-cookie') pushLine(rawHeaders[i + 1]);
    }
  }
  return pairs;
};

const mergeCookie = (prev, headers) => {
  const map = new Map();
  for (const p of String(prev || '')
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const i = p.indexOf('=');
    if (i > 0) map.set(p.slice(0, i), p);
  }
  for (const p of parseSetCookie(headers)) {
    const i = p.indexOf('=');
    if (i > 0) map.set(p.slice(0, i), p);
  }
  return [...map.values()].join('; ');
};

const hasOpenMusicCookie = (cookie) => {
  const c = String(cookie || '');
  return c.includes('openmusic_token=') && c.includes('openmusic_uid=');
};

const base64UrlFromBuffer = (buf) => {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const hmacSign = async (apiSignKey, payload) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(apiSignKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlFromBuffer(sig);
};

const browserHeaders = (base, cookie = '') => {
  const h = {
    Accept: '*/*',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    Referer: `${base}/`,
    Origin: base,
  };
  if (cookie) h.Cookie = cookie;
  return h;
};

const signedHeaders = async (base, url, apiSignKey, cookie = '') => {
  const uri = new URL(url);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = uuid();
  const entries = [...uri.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const query = entries.map(([k, v]) => `${k}=${v}`).join('&');
  // body 段对 GET 用空字符串（与 music.qqovo.cn / md3Music 一致）
  const payload = ['GET', uri.pathname, query, '', timestamp, nonce].join('\n');
  const sign = await hmacSign(apiSignKey, payload);
  return {
    ...browserHeaders(base, cookie),
    'X-OM-Ts': timestamp,
    'X-OM-Nonce': nonce,
    'X-OM-Sign': sign,
  };
};

const qualitiesFor = (server, preference = '320', { max = 3 } = {}) => {
  const pref = String(preference || '320').trim().toLowerCase();
  let chain;
  let aliases;
  if (server === 'tencent') {
    chain = ['atmos', 'master', 'flac', 'ogg', '320', '128'];
    aliases = {
      atmos: 'atmos',
      master: 'master',
      flac: 'flac',
      high: 'flac',
      ogg: 'ogg',
      '320': '320',
      '128': '128',
      sq: 'flac',
      viper_tape: 'flac',
    };
  } else if (server === 'qishui') {
    chain = [
      'viper_hifi',
      'viper_atmos',
      'viper_tape',
      'viper_clear',
      'studio',
      'hires',
      'lossless',
      'exhigh',
      '320',
      'higher',
      'standard',
      '128',
    ];
    aliases = {
      viper_hifi: 'viper_hifi',
      viper_atmos: 'viper_atmos',
      viper_tape: 'viper_tape',
      viper_clear: 'viper_clear',
      studio: 'studio',
      atmos: 'exhigh',
      master: 'exhigh',
      hires: 'hires',
      high: 'exhigh',
      flac: 'lossless',
      lossless: 'lossless',
      exhigh: 'exhigh',
      '320': 'exhigh',
      higher: 'exhigh',
      standard: 'standard',
      '128': 'standard',
    };
  } else {
    chain = ['sky', 'jymaster', 'lossless', 'exhigh', 'standard'];
    aliases = {
      sky: 'sky',
      jymaster: 'jymaster',
      dolby: 'sky',
      jyeffect: 'jymaster',
      atmos: 'exhigh',
      master: 'exhigh',
      viper_hifi: 'exhigh',
      viper_tape: 'exhigh',
      hires: 'lossless',
      high: 'exhigh',
      flac: 'lossless',
      lossless: 'lossless',
      exhigh: 'exhigh',
      '320': 'exhigh',
      higher: 'exhigh',
      standard: 'standard',
      '128': 'standard',
    };
  }
  const startKey = aliases[pref] || pref;
  // 下载「最高」从链顶开试
  const fromTop = ['atmos', 'master', 'sky', 'jymaster', 'viper_hifi', 'viper_atmos'].includes(
    String(preference || '').toLowerCase(),
  );
  const idx = fromTop ? 0 : chain.indexOf(startKey);
  const from = idx <= 0 ? chain : chain.slice(idx);
  const limit = Math.max(1, Number(max) || 3);
  return from.slice(0, limit);
};

const qualityRank = (server, keyOrLabel) => {
  const q = String(keyOrLabel || '')
    .trim()
    .toLowerCase();
  if (!q) return 0;
  const has = (s) => q.includes(s);
  if (server === 'tencent') {
    if (has('全景') || q === 'atmos' || has('q000')) return 100;
    if (has('母带') || q === 'master' || has('ai00') || has('臻品母带')) return 95;
    if (has('sq') || q === 'flac' || q === 'ogg' || has('无损')) return 80;
    if (has('hq') || q === '320' || has('高品')) return 50;
    if (has('标准') || q === '128' || q === 'standard') return 20;
    return 10;
  }
  if (server === 'qishui') {
    if (has('viper_hifi') || has('蝰蛇hifi') || has('蝰蛇 hifi')) return 100;
    if (has('viper_atmos') || has('蝰蛇全景')) return 96;
    if (has('viper_tape') || has('蝰蛇母带')) return 94;
    if (has('viper_clear') || has('蝰蛇超清')) return 92;
    if (has('studio') || has('录音室')) return 88;
    if (q === 'hires' || has('hi-res') || has('hires')) return 85;
    if (q === 'lossless' || has('无损') || q === 'flac') return 80;
    if (q === 'exhigh' || q === '320' || q === 'higher' || has('极高')) return 50;
    if (q === 'standard' || q === '128' || has('标准')) return 20;
    return 10;
  }
  if (has('环绕') || q === 'sky') return 100;
  if (has('母带') || q === 'jymaster' || has('超清')) return 98;
  if (has('杜比') || q === 'dolby') return 97;
  if (has('臻音') || q === 'jyeffect') return 90;
  if (q === 'hires' || has('hi-res') || has('hires')) return 85;
  if (q === 'lossless' || has('无损') || q === 'flac') return 80;
  if (q === 'exhigh' || q === '320' || q === 'higher' || has('极高')) return 50;
  if (q === 'standard' || q === '128' || has('标准')) return 20;
  return 10;
};

const mapEchoQuality = (quality) => {
  const q = String(quality || '320');
  if (q === 'high') return 'high';
  if (q === 'flac') return 'flac';
  if (q === 'viper_tape') return 'viper_tape';
  if (q === '128') return '128';
  return '320';
};

const mapResolvedQuality = (server, label) => {
  const rank = qualityRank(server, label);
  if (rank >= 90) return 'high';
  if (rank >= 80) return 'flac';
  if (rank >= 50) return '320';
  return '128';
};

/* ===================== qishui decrypt (OpenMusic) ===================== */
const encryptedBoxTypes = new Set(['senc', 'saio', 'saiz', 'sinf', 'schi', 'tenc', 'schm', 'frma']);
const containerBoxTypes = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);

function u32(data, offset) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, false);
}

function text(data) {
  return new TextDecoder().decode(data);
}

function box(data, wanted, start = 0, end = data.length) {
  let offset = start;
  while (offset + 8 <= end) {
    const size = u32(data, offset);
    if (size < 8 || offset + size > end) return null;
    if (text(data.subarray(offset + 4, offset + 8)) === wanted) {
      return { size, offset, data: data.subarray(offset + 8, offset + size) };
    }
    offset += size;
  }
  return null;
}

function bitCount(input) {
  let value = input;
  value -= (value >> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >> 2) & 0x33333333);
  return (((value + (value >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

function decodeSpadeA(value) {
  const source = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  if (source.length < 3) return '';
  const padding = (source[0] ^ source[1] ^ source[2]) - 48;
  if (padding < 0 || source.length < padding + 2) return '';
  const input = source.subarray(1, source.length - padding);
  const working = new Uint8Array(input.length + 2);
  working.set([0xfa, 0x55]);
  working.set(input, 2);
  const decoded = new Uint8Array(input.length);
  for (let index = 0; index < decoded.length; index += 1) {
    let byte = (input[index] ^ working[index]) - bitCount(index) - 21;
    while (byte < 0) byte += 0xff;
    decoded[index] = byte & 0xff;
  }
  const first = decoded[0];
  const skip = first >= 48 && first <= 57 ? first - 48 : first >= 97 && first <= 122 ? first - 87 : 255;
  const end = 1 + source.length - padding - 2 - skip;
  return end > 1 && end <= decoded.length ? text(decoded.subarray(1, end)) : '';
}

function resolveKey(value) {
  const raw = value.trim();
  const hex = /^[0-9a-f]{32}$/i.test(raw) ? raw : decodeSpadeA(raw);
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('汽水音频密钥无效');
  return Uint8Array.from(hex.match(/../g), (part) => parseInt(part, 16));
}

/** 仅拷贝视图自身字节，避免 new Uint8Array(view).buffer 在已独立 buffer 上再复制一次。 */
function toArrayBuffer(value) {
  if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
    return value.buffer;
  }
  return value.slice().buffer;
}

function concat(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function u32Bytes(value) {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function ascii(value) {
  return new TextEncoder().encode(value);
}


function sampleSizes(stsz) {
  const fixed = u32(stsz.data, 4);
  const count = u32(stsz.data, 8);
  if (count > 200_000 || (!fixed && 12 + count * 4 > stsz.data.length)) throw new Error('汽水音频样本数据无效');
  if (fixed) return new Uint32Array(count).fill(fixed);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) sizes[i] = u32(stsz.data, 12 + i * 4);
  return sizes;
}

function sampleToChunk(stsc) {
  const count = u32(stsc.data, 4);
  if (count > 20_000 || 8 + count * 12 > stsc.data.length) throw new Error('汽水音频 chunk 数据无效');
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * 12;
    entries.push({ firstChunk: u32(stsc.data, offset), samplesPerChunk: u32(stsc.data, offset + 4) });
  }
  return entries;
}

function samplesInChunk(chunk, entries) {
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index];
    const next = entries[index + 1];
    if (chunk >= current.firstChunk && (!next || chunk < next.firstChunk)) return current.samplesPerChunk;
  }
  return 0;
}

function rebuiltChunkOffsets(sizes, entries, chunkCount, mdatOffset) {
  const offsets = [];
  let sampleIndex = 0;
  let offset = mdatOffset;
  for (let chunk = 1; chunk <= chunkCount; chunk += 1) {
    offsets.push(offset);
    const count = samplesInChunk(chunk, entries);
    for (let index = 0; index < count && sampleIndex < sizes.length; index += 1) {
      offset += sizes[sampleIndex];
      sampleIndex += 1;
    }
  }
  return offsets;
}

function rewriteStco(data, offsets) {
  const count = u32(data, 4);
  if (count > offsets.length) throw new Error('汽水音频 chunk 偏移无效');
  const output = new Uint8Array(8 + count * 4);
  output.set(data.subarray(0, 8));
  const view = new DataView(output.buffer);
  for (let index = 0; index < count; index += 1) view.setUint32(8 + index * 4, offsets[index], false);
  return output;
}

function cleanBoxChildren(source, start, end, context) {
  const parts = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) {
      parts.push(source.subarray(offset, end));
      break;
    }
    const size = u32(source, offset);
    if (size < 8 || offset + size > end) {
      parts.push(source.subarray(offset, end));
      break;
    }
    const type = text(source.subarray(offset + 4, offset + 8));
    if (encryptedBoxTypes.has(type)) {
      offset += size;
      continue;
    }
    if (type === 'enca') {
      const fixedEnd = Math.min(offset + size, offset + 36);
      const fixed = source.subarray(offset + 8, fixedEnd);
      const inner = cleanBoxChildren(source, fixedEnd, offset + size, context);
      parts.push(u32Bytes(fixed.length + inner.length + 8), ascii('mp4a'), fixed, inner);
    } else if (type === 'stco') {
      const body = rewriteStco(source.subarray(offset + 8, offset + size), rebuiltChunkOffsets(
        context.sizes, context.stsc, context.chunkCount, context.mdatOffset,
      ));
      parts.push(u32Bytes(body.length + 8), ascii('stco'), body);
    } else if (containerBoxTypes.has(type)) {
      const fixedSize = type === 'stsd' ? 8 : 0;
      const fixedEnd = Math.min(offset + size, offset + 8 + fixedSize);
      const fixed = source.subarray(offset + 8, fixedEnd);
      const inner = cleanBoxChildren(source, fixedEnd, offset + size, context);
      parts.push(u32Bytes(fixed.length + inner.length + 8), ascii(type), fixed, inner);
    } else {
      parts.push(source.subarray(offset, offset + size));
    }
    offset += size;
  }
  return concat(parts);
}

function findFlacMetadata(stsd) {
  const marker = new TextEncoder().encode('dfLa');
  for (let index = 4; index + 4 <= stsd.data.length; index += 1) {
    if (stsd.data[index] !== marker[0] || stsd.data[index + 1] !== marker[1]
      || stsd.data[index + 2] !== marker[2] || stsd.data[index + 3] !== marker[3]) continue;
    const size = u32(stsd.data, index - 4);
    if (size >= 8 && index - 4 + size <= stsd.data.length) return stsd.data.subarray(index + 4, index - 4 + size);
  }
  return null;
}

async function decryptAudio(data, rawKey) {
  const moov = box(data, 'moov');
  if (!moov) throw new Error('汽水音频缺少 moov');
  const trak = box(data, 'trak', moov.offset + 8, moov.offset + moov.size);
  const mdia = trak && box(data, 'mdia', trak.offset + 8, trak.offset + trak.size);
  const minf = mdia && box(data, 'minf', mdia.offset + 8, mdia.offset + mdia.size);
  const stbl = minf && box(data, 'stbl', minf.offset + 8, minf.offset + minf.size);
  const stsd = stbl && box(data, 'stsd', stbl.offset + 8, stbl.offset + stbl.size);
  const stsz = stbl && box(data, 'stsz', stbl.offset + 8, stbl.offset + stbl.size);
  const stsc = stbl && box(data, 'stsc', stbl.offset + 8, stbl.offset + stbl.size);
  const stco = stbl && box(data, 'stco', stbl.offset + 8, stbl.offset + stbl.size);
  let senc = stbl && box(data, 'senc', stbl.offset + 8, stbl.offset + stbl.size);
  if (!senc) senc = box(data, 'senc', moov.offset + 8, moov.offset + moov.size);
  const mdat = box(data, 'mdat');
  if (!trak || !mdia || !minf || !stbl || !stsd || !stsz || !stsc || !stco || !senc || !mdat) throw new Error('汽水音频容器不完整');

  const sizes = sampleSizes(stsz);
  const stscEntries = sampleToChunk(stsc);
  const chunkCount = u32(stco.data, 4);
  if (chunkCount > 200_000 || 8 + chunkCount * 4 > stco.data.length) throw new Error('汽水音频 chunk 偏移无效');
  const sourceChunkOffsets = Array.from({ length: chunkCount }, (_, index) => u32(stco.data, 8 + index * 4));
  const ivCount = u32(senc.data, 4);
  if (ivCount > 200_000 || 8 + ivCount * 8 > senc.data.length) throw new Error('汽水音频 IV 数据无效');
  if (sizes.length > ivCount) throw new Error('汽水音频样本范围无效');

  const sampleOffsets = new Uint32Array(sizes.length);
  let sampleIndex = 0;
  for (let chunk = 1; chunk <= chunkCount && sampleIndex < sizes.length; chunk += 1) {
    let offset = sourceChunkOffsets[chunk - 1];
    const count = samplesInChunk(chunk, stscEntries);
    if (!count) throw new Error('汽水音频 chunk 映射无效');
    for (let index = 0; index < count && sampleIndex < sizes.length; index += 1) {
      const size = sizes[sampleIndex];
      if (offset + size > data.length) throw new Error('汽水音频样本范围无效');
      sampleOffsets[sampleIndex] = offset;
      offset += size;
      sampleIndex += 1;
    }
  }
  if (sampleIndex !== sizes.length) throw new Error('汽水音频样本与 chunk 映射不一致');

  const key = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(resolveKey(rawKey)),
    { name: 'AES-CTR' },
    false,
    ['decrypt'],
  );
  const metadata = findFlacMetadata(stsd);
  // 复用 16 字节 counter，避免为每个 sample 分配独立 IV Uint8Array（高采样数时对象开销巨大）
  const counter = new Uint8Array(16);
  if (metadata) {
    const header = new TextEncoder().encode('fLaC');
    const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
    const output = new Uint8Array(header.length + metadata.length + totalBytes);
    output.set(header, 0);
    output.set(metadata, header.length);
    let writeAt = header.length + metadata.length;
    for (let index = 0; index < sizes.length; index += 1) {
      const size = sizes[index];
      const sourceOffset = sampleOffsets[index];
      counter.fill(0);
      counter.set(senc.data.subarray(8 + index * 8, 16 + index * 8));
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CTR', counter: toArrayBuffer(counter), length: 64 },
        key,
        toArrayBuffer(data.subarray(sourceOffset, sourceOffset + size)),
      );
      output.set(new Uint8Array(decrypted), writeAt);
      writeAt += size;
    }
    return { data: output, contentType: 'audio/flac' };
  }

  const samples = [];
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index];
    const sourceOffset = sampleOffsets[index];
    counter.fill(0);
    counter.set(senc.data.subarray(8 + index * 8, 16 + index * 8));
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CTR', counter: toArrayBuffer(counter), length: 64 },
      key,
      toArrayBuffer(data.subarray(sourceOffset, sourceOffset + size)),
    );
    samples.push(new Uint8Array(decrypted));
  }
  const ftyp = box(data, 'ftyp');
  const draftMoov = cleanBoxChildren(data, moov.offset + 8, moov.offset + moov.size, {
    sizes, stsc: stscEntries, chunkCount, mdatOffset: 0,
  });
  const mdatOffset = (ftyp?.size || 0) + draftMoov.length + 16;
  const cleanMoovData = cleanBoxChildren(data, moov.offset + 8, moov.offset + moov.size, {
    sizes, stsc: stscEntries, chunkCount, mdatOffset,
  });
  const cleanMoov = concat([u32Bytes(cleanMoovData.length + 8), ascii('moov'), cleanMoovData]);
  const cleanMdatData = concat(samples);
  const cleanMdat = concat([u32Bytes(cleanMdatData.length + 8), ascii('mdat'), cleanMdatData]);
  return { data: concat([ftyp ? data.subarray(ftyp.offset, ftyp.offset + ftyp.size) : new Uint8Array(), cleanMoov, cleanMdat]), contentType: 'audio/mp4' };
}

/* ===================== qqovo client ===================== */
function createQqovoClient(net) {
  const request = async (options) => net.request(options);
  // 注意：EchoMusic 的 net.request 会走 Electron 会话 CookieJar。
  // 切勿优先用 fetch + credentials:omit，否则 bootstrap 的 openmusic_* 进不了 Jar，
  // 后续 meting 无 Cookie → 403 → 搜索「无结果」。
  const fetchFn =
    typeof net?.fetch === 'function'
      ? net.fetch.bind(net)
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : null;

  const normalizeFetchHeaders = (resp) => {
    const hdrBag = {};
    try {
      if (resp.headers && typeof resp.headers.forEach === 'function') {
        resp.headers.forEach((v, k) => {
          hdrBag[k] = v;
        });
      }
    } catch {
      /* ignore */
    }
    if (typeof resp.headers?.getSetCookie === 'function') {
      try {
        hdrBag['set-cookie'] = resp.headers.getSetCookie() || [];
      } catch {
        /* ignore */
      }
    }
    hdrBag.getSetCookie = resp.headers?.getSetCookie?.bind(resp.headers);
    return hdrBag;
  };

  const qqovoHttp = async ({
    url,
    method = 'GET',
    headers = {},
    body,
    responseType = 'json',
    timeoutMs = 15000,
  }) => {
    // 1) 优先 net.request：共享 Electron CookieJar（bootstrap → meting 同会话）
    try {
      return await request({
        url,
        method,
        headers,
        body,
        responseType,
        timeoutMs,
        validateStatus: undefined,
      });
    } catch (reqErr) {
      if (!fetchFn) throw reqErr;
      console.warn('[qqovo-music] net.request failed, fallback fetch', reqErr);
    }

    // 2) fetch 兜底：必须 include，才能带上/写入会话 Cookie
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl && timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const resp = await fetchFn(url, {
        method,
        headers,
        body: body ?? undefined,
        credentials: 'include',
        referrerPolicy: 'no-referrer',
        signal: ctrl?.signal,
      });
      const hdrBag = normalizeFetchHeaders(resp);
      let data;
      if (responseType === 'text') {
        data = await resp.text();
      } else if (responseType === 'arrayBuffer') {
        data = await resp.arrayBuffer();
      } else {
        const text = await resp.text();
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }
      }
      return { status: resp.status, data, headers: hdrBag };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const ensureSession = async (base) => {
    const cached = SESSION.byBase.get(base);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const boot = await qqovoHttp({
      url: `${base}/api/session/bootstrap`,
      method: 'POST',
      headers: {
        ...browserHeaders(base),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deviceId: uuid() }),
      responseType: 'json',
      timeoutMs: 12000,
    });
    const apiSignKey = String(boot.data?.apiSignKey || '').trim();
    if (!apiSignKey) {
      console.warn('[qqovo-music] bootstrap empty', base, boot.status);
      return null;
    }
    let cookie = mergeCookie('', boot.headers);
    const clientId = String(boot.data?.clientId || '').trim();
    if (clientId && !cookie.includes('openmusic_uid=')) {
      cookie = mergeCookie(cookie, {
        'set-cookie': [`openmusic_uid=${clientId}`],
      });
    }
    // Cookie 读不到也不阻断：Electron CookieJar 往往已自动存下 openmusic_*，
    // 后续 net.request 会自动带上；手动 Cookie 头只是增强。
    if (!hasOpenMusicCookie(cookie)) {
      console.warn(
        '[qqovo-music] bootstrap headers 无 openmusic_token，依赖 Electron CookieJar',
        base,
      );
    }
    const session = {
      key: apiSignKey,
      cookie,
      expiresAt: Date.now() + 8 * 60 * 1000,
    };
    SESSION.byBase.set(base, session);
    console.info(
      '[qqovo-music] bootstrap ok',
      base,
      'cookiePairs=',
      cookie ? cookie.split(';').length : 0,
    );
    return session;
  };

  const clearSession = async (base) => {
    SESSION.byBase.delete(base);
  };

  const meting = async ({ server, type, id = '', quality }) => {
    const songId = String(id || '').trim();
    if (!songId && type !== 'fm') return null;
    for (const base of QQOVO_BASES) {
      try {
        const session = await ensureSession(base);
        if (!session) continue;
        const q = quality ? `&quality=${encodeURIComponent(quality)}` : '';
        const idPart = songId ? `&id=${encodeURIComponent(songId)}` : '';
        const url = `${base}/api/meting?server=${server}&type=${type}${idPart}${q}`;
        const headers = await signedHeaders(base, url, session.key, session.cookie);
        const resp = await qqovoHttp({
          url,
          method: 'GET',
          headers,
          responseType: type === 'lrc' ? 'text' : 'json',
          timeoutMs: 15000,
        });
        // update cookies if any
        session.cookie = mergeCookie(session.cookie, resp.headers);
        if (resp.status === 403) {
          await clearSession(base);
          continue;
        }
        if (resp.status >= 500) continue;
        // text mode may still be JSON string for some types
        if (type === 'lrc') {
          const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data ?? '');
          try {
            const parsed = JSON.parse(body);
            return parsed;
          } catch {
            return body;
          }
        }
        return resp.data;
      } catch (e) {
        console.warn('[qqovo-music] meting failed', server, type, e);
        await clearSession(base);
      }
    }
    return null;
  };

  const resolveHit = async ({ server, id, preference = '320' }) => {
    const songId = String(id || '').trim();
    if (!songId) return null;
    const pref = String(preference || '320');
    const cacheKey = `${server}|${songId}|${pref}`;
    const cached = RESOLVE_HIT_CACHE.get(cacheKey);
    if (cached?.url) {
      if (server !== 'qishui' || cached.auth) return cached;
      RESOLVE_HIT_CACHE.delete(cacheKey);
    }

    const tryQualities = qualitiesFor(server, preference, {
      max: server === 'qishui' ? 8 : 3,
    });

    for (const base of QQOVO_BASES) {
      try {
        const session = await ensureSession(base);
        if (!session) continue;
        let best = null;
        let bestRank = -1;

        for (const quality of tryQualities) {
          const trackUrl = `${base}/api/meting?server=${server}&type=url&id=${encodeURIComponent(songId)}&quality=${encodeURIComponent(quality)}`;
          const headers = await signedHeaders(base, trackUrl, session.key, session.cookie);
          const trackResp = await qqovoHttp({
            url: trackUrl,
            method: 'GET',
            headers,
            responseType: 'json',
            timeoutMs: 15000,
          });
          session.cookie = mergeCookie(session.cookie, trackResp.headers);
          if (trackResp.status === 403) {
            await clearSession(base);
            return best;
          }
          if (trackResp.status !== 200 || !trackResp.data || typeof trackResp.data !== 'object') {
            continue;
          }
          let playUrl = String(trackResp.data.url || '').trim();
          let auth = String(trackResp.data.auth || trackResp.data.play_auth || '').trim();
          const returnedLabel = String(trackResp.data.quality || '').trim();
          if (playUrl.startsWith('/')) playUrl = `${base}${playUrl}`;

          // 汽水：/api/qishui-source 需二次展开拿 CDN + auth（可多跳）
          for (let hop = 0; hop < 3; hop += 1) {
            const needExpand =
              playUrl.startsWith('http') &&
              (playUrl.includes('qqovo.') ||
                playUrl.includes('/api/qishui') ||
                /\/api\/(meting|qishui-source)/i.test(playUrl));
            if (!needExpand) break;
            try {
              const srcHeaders = await signedHeaders(base, playUrl, session.key, session.cookie);
              const sourceResp = await qqovoHttp({
                url: playUrl,
                method: 'GET',
                headers: srcHeaders,
                responseType: 'text',
                timeoutMs: 15000,
              });
              session.cookie = mergeCookie(session.cookie, sourceResp.headers);
              let sourceData = sourceResp.data;
              if (typeof sourceData === 'string') {
                try {
                  sourceData = JSON.parse(sourceData);
                } catch {
                  sourceData = null;
                }
              }
              if (!sourceData || typeof sourceData !== 'object') break;
              const nextUrl = String(sourceData.url || '').trim();
              const nestedAuth = String(sourceData.auth || sourceData.play_auth || '').trim();
              if (nestedAuth) auth = nestedAuth;
              if (!nextUrl) break;
              playUrl = nextUrl.startsWith('/') ? `${base}${nextUrl}` : nextUrl;
            } catch (e) {
              console.warn('[qqovo-music] qishui expand hop failed', e);
              break;
            }
          }

          if (playUrl.startsWith('http://')) playUrl = `https://${playUrl.slice(7)}`;
          if (!playUrl.startsWith('http')) continue;

          const label = returnedLabel || quality;
          const rank = qualityRank(server, label);
          const reqRank = qualityRank(server, quality);
          const hit = {
            url: playUrl,
            auth: auth || null,
            quality: label,
            requestedQuality: quality,
            base,
          };
          // 汽水无 auth 的命中不作为最终结果（密文无法出声），但继续试下一档
          if (server === 'qishui' && !auth) {
            console.warn(
              `[qqovo-music] qishui no auth q=${quality} url=${playUrl.slice(0, 96)}`,
            );
            continue;
          }
          if (rank > bestRank) {
            best = hit;
            bestRank = rank;
          }
          console.info(
            `[qqovo-music] try ${server}/${songId} q=${quality} -> ${label} rank=${rank} auth=${auth ? 1 : 0}`,
          );
          if (rank >= reqRank || bestRank >= 80) {
            const out = best || hit;
            if (out) RESOLVE_HIT_CACHE.set(cacheKey, out);
            return out;
          }
        }
        if (best) {
          RESOLVE_HIT_CACHE.set(cacheKey, best);
          return best;
        }
      } catch (e) {
        console.warn('[qqovo-music] resolve failed', base, e);
        await clearSession(base);
      }
    }
    return null;
  };

  const resolveLyricLrc = async ({ server, id }) => {
    const songId = String(id || '').trim();
    if (!songId) return null;
    const cacheKey = `${server}:${songId}`;
    if (LYRIC_CACHE.has(cacheKey)) return LYRIC_CACHE.get(cacheKey);

    const data = await meting({ server, type: 'lrc', id: songId });
    if (data == null) return null;

    const takeBody = async (raw) => {
      const s = String(raw || '').trim();
      if (!s) return null;
      if (s.startsWith('http://') || s.startsWith('https://')) {
        try {
          const resp = await request({
            url: s,
            method: 'GET',
            responseType: 'text',
            timeoutMs: 10000,
          });
          const body = String(resp.data || '').trim();
          if (!body || body.startsWith('<')) return null;
          return body;
        } catch {
          return null;
        }
      }
      if (s.startsWith('<') || s.startsWith('{')) return null;
      return s;
    };

    let text = null;
    if (typeof data === 'string') {
      text = await takeBody(data);
    } else if (data && typeof data === 'object') {
      text = await takeBody(data.lrc || data.lyric || data.content || '');
    }
    if (text) LYRIC_CACHE.set(cacheKey, text);
    return text;
  };

  const search = async ({ server, keyword }) => {
    // 与 md3Music 一致：netease / tencent(qq) / qishui(soda) 均走 qqovo meting search
    const data = await meting({ server, type: 'search', id: String(keyword || '').trim() });
    if (!Array.isArray(data)) return [];
    return data.filter((x) => x && typeof x === 'object');
  };

  const playlist = async ({ server, id }) => {
    const data = await meting({ server, type: 'playlist', id });
    if (!Array.isArray(data)) return [];
    return data.filter((x) => x && typeof x === 'object');
  };

  /** 私人漫游：qqovo type=fm；网易/汽水模式作 id */
  const fm = async ({ server, mode = 'DEFAULT', sourceId = 'qq' }) => {
    const modeId = fmMetingId(mode, sourceId);
    const data = await meting({ server, type: 'fm', id: modeId });
    if (!Array.isArray(data)) return [];
    return data.filter((x) => x && typeof x === 'object');
  };

  /** 网易官方封面批量解析 */
  const resolveNeteasePicUrls = async (ids) => {
    const clean = [...new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean))];
    const out = {};
    if (!clean.length) return out;
    const hosts = [
      'https://music.163.com',
      'https://interface.music.163.com',
      'https://api.music.163.com',
    ];
    for (let i = 0; i < clean.length; i += 40) {
      const slice = clean.slice(i, i + 40);
      const idsParam = `[${slice.join(',')}]`;
      for (const host of hosts) {
        try {
          const resp = await request({
            url: `${host}/api/song/detail?ids=${encodeURIComponent(idsParam)}`,
            method: 'GET',
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
              Referer: 'https://music.163.com/',
              Accept: 'application/json',
            },
            responseType: 'json',
            timeoutMs: 10000,
          });
          const songs = Array.isArray(resp.data?.songs) ? resp.data.songs : [];
          for (const raw of songs) {
            const sid = String(raw?.id || '').trim();
            const pic = httpsify(raw?.al?.picUrl || raw?.album?.picUrl || raw?.album_pic || '');
            if (sid && pic.startsWith('http')) out[sid] = pic;
          }
          if (slice.every((id) => out[id])) break;
        } catch (e) {
          console.warn('[qqovo-music] netease pic', host, e);
        }
      }
    }
    return out;
  };

  /** 用 meting song 补 CDN 封面（QQ/汽水/网易兜底） */
  const resolvePicViaSong = async ({ server, id }) => {
    try {
      const data = await meting({ server, type: 'song', id });
      let raw = null;
      if (data && typeof data === 'object' && !Array.isArray(data)) raw = data;
      else if (Array.isArray(data) && data[0] && typeof data[0] === 'object') raw = data[0];
      if (!raw) return '';
      const pic = httpsify(raw.pic || raw.cover || raw.album_pic || '');
      if (!pic || isProxyMediaHost(pic)) return '';
      return pic;
    } catch {
      return '';
    }
  };

  /** OpenMusic 全站平台热榜 */
  const getPlatformHot = async (limit = 50) => {
    const n = Math.max(1, Math.min(100, Number(limit) || 50));
    for (const base of QQOVO_BASES) {
      try {
        const session = await ensureSession(base);
        if (!session) continue;
        const url = `${base}/api/music/hot?limit=${n}`;
        const headers = await signedHeaders(base, url, session.key, session.cookie);
        const resp = await qqovoHttp({
          url,
          method: 'GET',
          headers,
          responseType: 'json',
          timeoutMs: 15000,
        });
        session.cookie = mergeCookie(session.cookie, resp.headers);
        if (resp.status === 403) {
          await clearSession(base);
          continue;
        }
        if (!Array.isArray(resp.data)) continue;
        return resp.data.filter((x) => x && typeof x === 'object');
      } catch (e) {
        console.warn('[qqovo-music] platform hot failed', e);
        await clearSession(base);
      }
    }
    return [];
  };

  /** QQ/汽水榜单列表（musicdl 仅作目录；播链仍走 qqovo） */
  const listMusicdlToplists = async (sourceId) => {
    const src = musicdlSourceOf(sourceId);
    const resp2 = await request({
      url: `${MUSICDL_BASE}/api/v1/toplist?source=${encodeURIComponent(src)}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      responseType: 'json',
      timeoutMs: 20000,
    });
    const list = Array.isArray(resp2.data?.toplists) ? resp2.data.toplists : [];
    return list
      .filter((x) => x && typeof x === 'object')
      .map((t) => ({
        id: String(t.id || '').trim(),
        name: String(t.name || '榜单').trim(),
        cover: httpsify(t.cover || ''),
        group: String(t.group || '').trim(),
        sourceId,
        kind: 'musicdl',
      }))
      .filter((t) => t.id);
  };

  const musicdlToplistSongs = async (sourceId, chartId, num = 50) => {
    const src = musicdlSourceOf(sourceId);
    const resp = await request({
      url: `${MUSICDL_BASE}/api/v1/toplist/songs?source=${encodeURIComponent(src)}&id=${encodeURIComponent(chartId)}&num=${num}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      responseType: 'json',
      timeoutMs: 25000,
    });
    const list = Array.isArray(resp.data?.songs) ? resp.data.songs : [];
    return list.filter((x) => x && typeof x === 'object');
  };

  const warm = async () => {
    for (const base of QQOVO_BASES) {
      const s = await ensureSession(base);
      if (s) return true;
    }
    return false;
  };

  /** 展开 qqovo 代理播链到真实 CDN + auth */
  const expandPlayUrl = async (url, auth = '') => {
    let playUrl = String(url || '').trim();
    let playAuth = String(auth || '').trim();
    for (let hop = 0; hop < 3; hop += 1) {
      const needExpand =
        playUrl.includes('qqovo.') ||
        playUrl.includes('/api/qishui') ||
        /\/api\/(meting|qishui-source)/i.test(playUrl);
      if (!playUrl || !needExpand) break;
      let expanded = false;
      for (const base of QQOVO_BASES) {
        try {
          let abs = playUrl;
          if (abs.startsWith('/')) abs = `${base}${abs}`;
          const session = await ensureSession(base);
          if (!session) continue;
          const headers = await signedHeaders(base, abs, session.key, session.cookie);
          const resp = await qqovoHttp({
            url: abs,
            method: 'GET',
            headers,
            responseType: 'text',
            timeoutMs: 15000,
          });
          session.cookie = mergeCookie(session.cookie, resp.headers);
          let data = resp.data;
          if (typeof data === 'string') {
            try {
              data = JSON.parse(data);
            } catch {
              data = null;
            }
          }
          if (!data || typeof data !== 'object') continue;
          const next = String(data.url || '').trim();
          const nestedAuth = String(data.auth || data.play_auth || '').trim();
          if (nestedAuth) playAuth = nestedAuth;
          if (next) {
            playUrl = next.startsWith('/') ? `${base}${next}` : next;
            expanded = true;
            break;
          }
        } catch (e) {
          console.warn('[qqovo-music] expandPlayUrl', base, e);
        }
      }
      if (!expanded) break;
    }
    if (playUrl.startsWith('http://')) playUrl = `https://${playUrl.slice(7)}`;
    return { url: playUrl, auth: playAuth };
  };

  return {
    meting,
    resolveHit,
    resolveLyricLrc,
    search,
    playlist,
    fm,
    getPlatformHot,
    listMusicdlToplists,
    musicdlToplistSongs,
    resolveNeteasePicUrls,
    resolvePicViaSong,
    expandPlayUrl,
    warm,
    ensureSession,
  };
}

/* ===================== song helpers ===================== */
const trackSource = (sourceId) => `${PLUGIN_SOURCE_PREFIX}-${sourceId}`;

const isQqovoTrack = (track) =>
  Boolean(track?.source && String(track.source).startsWith(`${PLUGIN_SOURCE_PREFIX}-`));

const getTrackMeta = (track) => {
  const server = track?._qqovoServer || serverOf(String(track?.source || '').replace(`${PLUGIN_SOURCE_PREFIX}-`, ''));
  const id = String(track?._qqovoId || track?.mixSongId || '').trim();
  return { server, id };
};

const durationSec = (raw) => {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 10000 ? Math.round(raw / 1000) : Math.round(raw);
};

const extractMetingMediaId = (url) => {
  const u = String(url || '').trim();
  if (!u || !u.includes('id=')) return '';
  try {
    const fromUri = new URL(u).searchParams.get('id');
    if (fromUri) return fromUri.trim();
  } catch {}
  const m = /[?&]id=([^&]+)/.exec(u);
  return m ? decodeURIComponent(m[1]).trim() : '';
};

const isProxyMediaHost = (url) => {
  try {
    const host = new URL(httpsify(url)).host.toLowerCase();
    return host.includes('qqovo') || host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
};

const normalizeArtist = (raw) => {
  if (Array.isArray(raw)) {
    return raw
      .map((e) => (e && typeof e === 'object' ? String(e.name || '') : String(e || '')))
      .filter(Boolean)
      .join(' / ');
  }
  return String(raw || '').trim();
};

const songFromMeting = (raw, sourceId) => {
  const urlStr = String(raw.url || '');
  const picRaw = String(raw.pic || raw.cover || raw.album_pic || '').trim();
  const lrcStr = String(raw.lrc || '').trim();
  let id = String(
    raw.id || raw.songid || raw.song_id || raw.mid || raw.songmid || '',
  ).trim();
  // 网易 FM 常无 id，要从代理 url/pic/lrc 里抠
  if (!id) id = extractMetingMediaId(urlStr);
  if (!id) id = extractMetingMediaId(picRaw);
  if (!id) id = extractMetingMediaId(lrcStr);
  if (!id) return null;

  const title = String(raw.name || raw.title || raw.song || '').trim() || '未知歌曲';
  const artist = normalizeArtist(raw.artist ?? raw.author ?? raw.singer) || '未知歌手';
  const album = String(raw.album || raw.album_name || '').trim();
  const server = serverOf(sourceId);
  let pic = httpsify(picRaw);
  // 勿把未签名 qqovo/localhost 代理图塞进 UI（会 403）
  if (pic && isProxyMediaHost(pic)) pic = '';

  const hash = `qqovo_${sourceId}_${id}`;
  return {
    id: `qqovo:${sourceId}:${id}`,
    songId: id,
    title,
    name: title,
    artist,
    artists: artist ? [{ name: artist }] : [],
    singers: artist ? [{ name: artist }] : [],
    album,
    albumName: album,
    duration: durationSec(Number(raw.duration || raw.dt || 0)),
    coverUrl: pic,
    cover: pic,
    audioUrl: '',
    hash,
    mixSongId: id,
    source: trackSource(sourceId),
    privilege: 0,
    _qqovoServer: server,
    _qqovoId: id,
    _qqovoSourceId: sourceId,
  };
};

const songFromPlatformHot = (raw) => {
  const sourceId = sourceIdFromApi(raw.source);
  const id = String(raw.id || '').trim();
  if (!id) return null;
  let pic = httpsify(raw.pic || raw.cover || '');
  if (pic && isProxyMediaHost(pic)) pic = '';
  const title = String(raw.name || raw.title || '').trim() || '未知歌曲';
  const artist = normalizeArtist(raw.artist ?? raw.author) || '未知歌手';
  const album = String(raw.album || '').trim();
  const server = serverOf(sourceId);
  const hash = `qqovo_${sourceId}_${id}`;
  return {
    id: `qqovo:${sourceId}:${id}`,
    songId: id,
    title,
    name: title,
    artist,
    artists: artist ? [{ name: artist }] : [],
    singers: artist ? [{ name: artist }] : [],
    album,
    albumName: album,
    duration: durationSec(Number(raw.duration || 0)),
    coverUrl: pic,
    cover: pic,
    audioUrl: '',
    hash,
    mixSongId: id,
    source: trackSource(sourceId),
    privilege: 0,
    _qqovoServer: server,
    _qqovoId: id,
    _qqovoSourceId: sourceId,
  };
};

const songFromMusicdl = (raw, sourceId) => {
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const title = String(raw.name || raw.title || '').trim() || '未知歌曲';
  const artist = normalizeArtist(raw.artist ?? raw.author) || '未知歌手';
  const album = String(raw.album || '').trim();
  let pic = httpsify(raw.cover || raw.pic || '');
  if (pic && isProxyMediaHost(pic)) pic = '';
  const server = serverOf(sourceId);
  const hash = `qqovo_${sourceId}_${id}`;
  return {
    id: `qqovo:${sourceId}:${id}`,
    songId: id,
    title,
    name: title,
    artist,
    artists: artist ? [{ name: artist }] : [],
    singers: artist ? [{ name: artist }] : [],
    album,
    albumName: album,
    duration: durationSec(Number(raw.duration || 0)),
    coverUrl: pic,
    cover: pic,
    audioUrl: '',
    hash,
    mixSongId: id,
    source: trackSource(sourceId),
    privilege: 0,
    _qqovoServer: server,
    _qqovoId: id,
    _qqovoSourceId: sourceId,
  };
};

const lunaHeaders = {
  'User-Agent':
    'com.luna.music/100198030 (Linux; U; Android 15; zh_CN_#Hans; ABR-AL80; Build/V417IR;tt-ok/3.12.13.19)',
  Referer: 'https://www.qishui.com/',
  Accept: '*/*',
};

const DOWNLOAD_QUALITY_OPTIONS = {
  qq: [
    { id: 'best', label: '最高音质', preference: 'atmos' },
    { id: 'atmos', label: '全景声', preference: 'atmos' },
    { id: 'master', label: '臻品母带', preference: 'master' },
    { id: 'flac', label: '无损 FLAC', preference: 'flac' },
    { id: '320', label: '320K', preference: '320' },
    { id: '128', label: '128K', preference: '128' },
  ],
  netease: [
    { id: 'best', label: '最高音质', preference: 'sky' },
    { id: 'sky', label: '沉浸环绕', preference: 'sky' },
    { id: 'jymaster', label: '超清母带', preference: 'jymaster' },
    { id: 'lossless', label: '无损', preference: 'lossless' },
    { id: 'exhigh', label: '极高', preference: 'exhigh' },
    { id: 'standard', label: '标准', preference: 'standard' },
  ],
  qishui: [
    { id: 'best', label: '最高音质', preference: 'viper_hifi' },
    { id: 'viper_hifi', label: '蝰蛇 HiFi', preference: 'viper_hifi' },
    { id: 'viper_atmos', label: '蝰蛇全景', preference: 'viper_atmos' },
    { id: 'hires', label: 'Hi-Res', preference: 'hires' },
    { id: 'lossless', label: '无损', preference: 'lossless' },
    { id: 'exhigh', label: '极高', preference: 'exhigh' },
    { id: 'standard', label: '标准', preference: 'standard' },
  ],
};

const safeFileName = (title, artist, ext) => {
  const base = `${artist || '未知'} - ${title || '未命名'}`
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base}.${ext}`;
};

const triggerBrowserDownload = (bytes, filename, mime) => {
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
};

async function ensureQishuiServer(ctx) {
  if (qishuiServerOrigin) return qishuiServerOrigin;
  if (PREFETCH_INFLIGHT.has('qishui-server')) {
    await PREFETCH_INFLIGHT.get('qishui-server');
    if (qishuiServerOrigin) return qishuiServerOrigin;
  }
  // 宿主 webServer 单次响应上限 8MB；FFmpeg HTTP 源支持分段 Range，按块返回
  const MAX_BODY = 7 * 1024 * 1024;
  const boot = (async () => {
    const result = await ctx.webServer.listen((req) => {
      const raw = String(req.path || req.url || '');
      let key = raw.split('?')[0];
      try {
        key = decodeURIComponent(key);
      } catch {}
      key = key.replace(/^\/+/, '');
      let hit = QISHUI_FILES.get(key) || QISHUI_FILES.get(`/${key}`) || QISHUI_FILES.get(raw);
      if (!hit) {
        const baseName = key.split('/').filter(Boolean).pop();
        if (baseName) hit = QISHUI_FILES.get(baseName) || QISHUI_FILES.get(`/${baseName}`);
      }
      if (!hit) {
        console.warn(
          '[qqovo-music] qishui 404',
          { raw, key, known: [...QISHUI_FILES.keys()].slice(0, 8) },
        );
        return { status: 404, body: 'not found' };
      }

      const total = hit.bytes.byteLength;
      const baseHeaders = {
        'Content-Type': hit.mime || 'audio/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };

      if (String(req.method || 'GET').toUpperCase() === 'HEAD') {
        return {
          status: 200,
          headers: { ...baseHeaders, 'Content-Length': String(total) },
          body: new ArrayBuffer(0),
        };
      }

      const headers = req.headers || {};
      const rangeHeader = String(headers.range || headers.Range || '').trim();

      if (!rangeHeader) {
        if (total <= MAX_BODY) {
          return {
            status: 200,
            headers: { ...baseHeaders, 'Content-Length': String(total) },
            body: hit.bytes,
          };
        }
        const end = Math.min(total - 1, MAX_BODY - 1);
        const slice = hit.bytes.slice(0, end + 1);
        return {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Length': String(slice.byteLength),
            'Content-Range': `bytes 0-${end}/${total}`,
          },
          body: slice,
        };
      }

      let start = 0;
      let end = Math.min(total - 1, MAX_BODY - 1);
      if (/^bytes=/i.test(rangeHeader)) {
        const spec = rangeHeader.replace(/^bytes=/i, '');
        const [a, b] = spec.split('-');
        const parsedStart = a === '' ? 0 : Number(a);
        if (Number.isFinite(parsedStart) && parsedStart >= 0) {
          start = Math.min(parsedStart, Math.max(0, total - 1));
        }
        if (b !== undefined && b !== '') {
          const parsedEnd = Number(b);
          end = Number.isFinite(parsedEnd)
            ? Math.min(parsedEnd, total - 1, start + MAX_BODY - 1)
            : Math.min(start + MAX_BODY - 1, total - 1);
        } else {
          end = Math.min(start + MAX_BODY - 1, total - 1);
        }
      }

      if (start > end || start >= total) {
        return {
          status: 416,
          headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` },
          body: 'range not satisfiable',
        };
      }

      const slice = hit.bytes.slice(start, end + 1);
      return {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Length': String(slice.byteLength),
          'Content-Range': `bytes ${start}-${end}/${total}`,
        },
        body: slice,
      };
    });
    if (!result?.ok) {
      throw new Error(result?.error || '汽水本地服务启动失败（需 webServer 能力）');
    }
    qishuiServerOrigin = result.origin || `http://127.0.0.1:${result.port}`;
    console.info('[qqovo-music] qishui server', qishuiServerOrigin);
    return qishuiServerOrigin;
  })();
  PREFETCH_INFLIGHT.set('qishui-server', boot);
  try {
    return await boot;
  } finally {
    PREFETCH_INFLIGHT.delete('qishui-server');
  }
}

const looksLikeAudioBytes = (bytes) => {
  if (!bytes || bytes.byteLength < 12) return false;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return true;
  if (u8[0] === 0x66 && u8[1] === 0x4c && u8[2] === 0x61 && u8[3] === 0x43) return true;
  if (u8[0] === 0x4f && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53) return true;
  if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return true;
  return false;
};

async function materializeQishui(ctx, client, url, auth, cacheKey) {
  const cached = PLAY_URL_CACHE.get(cacheKey);
  if (cached) {
    // file:// 直接复用；http 本机则确认文件仍在 map 且 origin 一致
    if (String(cached).startsWith('file:')) return cached;
    const name = String(cached).split('/').pop();
    if (
      name &&
      QISHUI_FILES.has(name) &&
      qishuiServerOrigin &&
      String(cached).startsWith(qishuiServerOrigin)
    ) {
      return cached;
    }
    PLAY_URL_CACHE.delete(cacheKey);
  }
  const lockKey = `mat:${cacheKey}`;
  if (PREFETCH_INFLIGHT.has(lockKey)) return PREFETCH_INFLIGHT.get(lockKey);

  const run = (async () => {
    let playUrl = String(url || '').trim();
    let playAuth = String(auth || '').trim();
    if (client?.expandPlayUrl) {
      const expanded = await client.expandPlayUrl(playUrl, playAuth);
      playUrl = expanded.url;
      playAuth = expanded.auth;
    }
    if (!playUrl.startsWith('http')) throw new Error('汽水无可用播放地址');
    if (!playAuth) throw new Error('汽水缺少解密参数 auth');

    let encrypted;
    try {
      const resp = await ctx.net.fetch(playUrl, {
        method: 'GET',
        headers: lunaHeaders,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!resp.ok) throw new Error(`汽水 CDN 请求失败: ${resp.status}`);
      encrypted = new Uint8Array(await resp.arrayBuffer());
    } catch (fetchErr) {
      console.warn('[qqovo-music] fetch CDN failed, fallback net.request', fetchErr);
      const resp = await ctx.net.request({
        url: playUrl,
        method: 'GET',
        headers: lunaHeaders,
        responseType: 'arrayBuffer',
        timeoutMs: 120000,
        maxResponseBytes: 96 * 1024 * 1024,
      });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`汽水 CDN 请求失败: ${resp.status}`);
      }
      encrypted = new Uint8Array(resp.data);
    }
    if (encrypted.byteLength < 2048) throw new Error('汽水音频过小');

    let bytes;
    let mime = 'audio/mp4';
    let ext = 'm4a';
    try {
      const decrypted = await decryptAudio(encrypted, playAuth);
      bytes = decrypted.data;
      mime = decrypted.contentType || 'audio/mp4';
      ext = mime.includes('flac') ? 'flac' : 'm4a';
    } catch (decErr) {
      if (looksLikeAudioBytes(encrypted)) {
        console.warn('[qqovo-music] decrypt failed, use raw audio', decErr);
        bytes = encrypted;
      } else {
        throw decErr;
      }
    }

    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const fileKey = `qishui-${String(cacheKey).replace(/[^a-zA-Z0-9._-]/g, '_')}.${ext}`.slice(
      0,
      120,
    );

    // 优先写插件目录 file://（避开 webServer IPC/404）；≤8MB 可写
    const MAX_WRITE = 8 * 1024 * 1024;
    if (copy.byteLength <= MAX_WRITE && ctx.fs?.writeFile) {
      try {
        const written = await ctx.fs.writeFile(`cache/${fileKey}`, copy.buffer, {
          overwrite: true,
        });
        if (written?.ok && written.url) {
          PLAY_URL_CACHE.set(cacheKey, written.url);
          console.info('[qqovo-music] qishui file ready', written.url, copy.byteLength, mime);
          return written.url;
        }
        if (written?.ok && written.path) {
          const path = String(written.path);
          const fileUrl = path.startsWith('file:')
            ? path
            : pathToFileUrl(path);
          PLAY_URL_CACHE.set(cacheKey, fileUrl);
          console.info('[qqovo-music] qishui file ready', fileUrl, copy.byteLength, mime);
          return fileUrl;
        }
        console.warn('[qqovo-music] writeFile failed, fallback http', written?.error);
      } catch (e) {
        console.warn('[qqovo-music] writeFile threw, fallback http', e);
      }
    }

    // 大文件或写盘失败：走本机 HTTP（Range）
    QISHUI_FILES.set(fileKey, { bytes: copy.buffer, mime });
    // 兼容多种 path 形态，避免 404
    QISHUI_FILES.set(`/${fileKey}`, { bytes: copy.buffer, mime });
    const origin = await ensureQishuiServer(ctx);
    const localUrl = `${origin}/${fileKey}`;
    PLAY_URL_CACHE.set(cacheKey, localUrl);
    console.info('[qqovo-music] qishui http ready', localUrl, copy.byteLength, mime);
    return localUrl;
  })();

  PREFETCH_INFLIGHT.set(lockKey, run);
  try {
    return await run;
  } finally {
    if (PREFETCH_INFLIGHT.get(lockKey) === run) PREFETCH_INFLIGHT.delete(lockKey);
  }
}

const pathToFileUrl = (path) => {
  const normalized = String(path || '').replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${normalized}`;
  if (normalized.startsWith('/')) return `file://${normalized}`;
  return `file:///${normalized}`;
};

async function fetchTrackBytes(ctx, client, track, preference) {
  const { server, id } = getTrackMeta(track);
  if (!server || !id) throw new Error('缺少音源 id');
  const hit = await client.resolveHit({ server, id, preference });
  if (!hit?.url) throw new Error('解析下载地址失败');

  if (server === 'qishui') {
    const resp = await ctx.net.request({
      url: hit.url,
      method: 'GET',
      headers: lunaHeaders,
      responseType: 'arrayBuffer',
      timeoutMs: 120000,
      maxResponseBytes: 96 * 1024 * 1024,
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`汽水 CDN 失败: ${resp.status}`);
    }
    const encrypted = new Uint8Array(resp.data);
    if (hit.auth) {
      const decrypted = await decryptAudio(encrypted, hit.auth);
      const mime = decrypted.contentType || 'audio/mp4';
      return {
        bytes: decrypted.data,
        mime,
        ext: mime.includes('flac') ? 'flac' : 'm4a',
        quality: hit.quality || preference,
      };
    }
    return { bytes: encrypted, mime: 'audio/mp4', ext: 'm4a', quality: hit.quality || preference };
  }

  const resp = await ctx.net.request({
    url: hit.url,
    method: 'GET',
    headers: {
      Accept: '*/*',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer:
        server === 'netease' ? 'https://music.163.com/' : 'https://y.qq.com/',
    },
    responseType: 'arrayBuffer',
    timeoutMs: 120000,
    maxResponseBytes: 96 * 1024 * 1024,
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`下载失败: ${resp.status}`);
  }
  const bytes = new Uint8Array(resp.data);
  const ct = String(resp.headers?.['content-type'] || '');
  const urlLower = hit.url.toLowerCase();
  let ext = 'mp3';
  if (urlLower.includes('.flac') || ct.includes('flac')) ext = 'flac';
  else if (urlLower.includes('.m4a') || ct.includes('mp4')) ext = 'm4a';
  else if (urlLower.includes('.ogg')) ext = 'ogg';
  else if (urlLower.includes('.wav')) ext = 'wav';
  return {
    bytes,
    mime: ct || 'application/octet-stream',
    ext,
    quality: hit.quality || preference,
  };
}

function prefetchLyric(client, track, ctx) {
  if (!isQqovoTrack(track)) return;
  const { server, id } = getTrackMeta(track);
  if (!server || !id) return;
  const key = `${server}:${id}`;
  if (LYRIC_CACHE.has(key)) return;
  if (PREFETCH_INFLIGHT.has(`lrc:${key}`)) return;
  const run = client
    .resolveLyricLrc({ server, id })
    .then((text) => {
      if (!text || !ctx) return;
      try {
        const current = ctx.stores?.player?.currentTrackSnapshot;
        if (!isQqovoTrack(current)) return;
        const meta = getTrackMeta(current);
        if (meta.server !== server || meta.id !== id) return;
        // 后台补歌词，避免挡在宿主 2.5s 超时之后才有字
        ctx.stores?.lyric?.setLyric?.(text, current.hash || '');
        ctx.lyric?.setLyric?.(text, current.hash || '');
      } catch {}
    })
    .catch(() => null);
  PREFETCH_INFLIGHT.set(`lrc:${key}`, run);
  void run.finally(() => {
    if (PREFETCH_INFLIGHT.get(`lrc:${key}`) === run) PREFETCH_INFLIGHT.delete(`lrc:${key}`);
  });
}

/** 网易漫游封面：官方 detail 批量 + meting song 兜底 */
async function enrichNeteaseCovers(client, songs) {
  const list = Array.isArray(songs) ? songs : [];
  const missing = list.filter((s) => {
    const pic = String(s?.coverUrl || s?.cover || '').trim();
    return !pic || isProxyMediaHost(pic);
  });
  if (!missing.length) return list;

  const ids = missing.map((s) => String(s._qqovoId || '').trim()).filter(Boolean);
  try {
    const map = await client.resolveNeteasePicUrls(ids);
    for (const song of missing) {
      const pic = httpsify(map[String(song._qqovoId)] || '');
      if (pic.startsWith('http') && !isProxyMediaHost(pic)) {
        song.coverUrl = pic;
        song.cover = pic;
      }
    }
  } catch (e) {
    console.warn('[qqovo-music] enrich netease covers', e);
  }

  const still = missing.filter((s) => !String(s.coverUrl || '').startsWith('http'));
  await Promise.all(
    still.slice(0, 16).map(async (song) => {
      try {
        const pic = await client.resolvePicViaSong({
          server: song._qqovoServer || 'netease',
          id: song._qqovoId,
        });
        if (pic) {
          song.coverUrl = pic;
          song.cover = pic;
        }
      } catch {}
    }),
  );
  return list;
}

/** 预解析播链；汽水一并预解密到本机 HTTP，切歌可秒开 */
function prefetchTrackPlayback(ctx, client, track, quality) {
  if (!isQqovoTrack(track)) return;
  const { server, id } = getTrackMeta(track);
  if (!server || !id) return;
  const preference = mapEchoQuality(quality);
  const resolveKey = `${server}|${id}|${preference}`;
  const inflightKey = `play:${resolveKey}`;
  if (PREFETCH_INFLIGHT.has(inflightKey)) return;

  const run = (async () => {
    const hit =
      RESOLVE_HIT_CACHE.get(resolveKey) ||
      (await client.resolveHit({ server, id, preference }));
    if (!hit?.url) return;
    if (server === 'qishui') {
      const playKey = `${id}:${hit.quality || hit.requestedQuality || preference}`;
      if (!PLAY_URL_CACHE.has(playKey)) {
        await materializeQishui(ctx, client, hit.url, hit.auth, playKey);
      }
    }
  })().catch((e) => {
    console.warn('[qqovo-music] prefetch play', id, e);
  });

  PREFETCH_INFLIGHT.set(inflightKey, run);
  void run.finally(() => {
    if (PREFETCH_INFLIGHT.get(inflightKey) === run) PREFETCH_INFLIGHT.delete(inflightKey);
  });
}

function collectPrefetchTracks(playlistStore, current, limit = 2) {
  const out = [];
  if (!current) return out;
  const queue = playlistStore?.activeQueue || playlistStore?.currentPlaybackQueue;
  const songs = Array.isArray(queue?.songs) ? queue.songs : [];
  if (!songs.length) return out;
  const curId = String(current.id || '');
  let idx = songs.findIndex((s) => String(s?.id || '') === curId);
  if (idx < 0) idx = songs.findIndex((s) => String(s?.mixSongId || '') === String(current.mixSongId || ''));
  if (idx < 0) return out;
  for (let i = 1; i <= limit && idx + i < songs.length; i += 1) {
    const t = songs[idx + i];
    if (isQqovoTrack(t)) out.push(t);
  }
  return out;
}

/* ---------- 本地收藏（宿主收藏走酷狗云，qqovo 曲无法入库） ---------- */
function favKeyOf(track) {
  if (!isQqovoTrack(track)) return '';
  const { server, id } = getTrackMeta(track);
  return server && id ? `${server}|${id}` : '';
}

function loadLocalFavMapSync() {
  try {
    const raw = localStorage.getItem(LOCAL_FAV_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveLocalFavMap(map) {
  try {
    localStorage.setItem(LOCAL_FAV_STORAGE_KEY, JSON.stringify(map || {}));
  } catch {}
}

function isLocalFavorite(track) {
  const key = favKeyOf(track);
  if (!key) return false;
  return Boolean(loadLocalFavMapSync()[key]);
}

function toggleLocalFavorite(track) {
  const key = favKeyOf(track);
  if (!key) return false;
  const map = loadLocalFavMapSync();
  if (map[key]) {
    delete map[key];
    saveLocalFavMap(map);
    return false;
  }
  map[key] = {
    id: track.id,
    title: track.title || track.name,
    artist: track.artist,
    coverUrl: track.coverUrl || track.cover || '',
    source: track.source,
    _qqovoServer: track._qqovoServer,
    _qqovoId: track._qqovoId,
    _qqovoSourceId: track._qqovoSourceId,
    mixSongId: track.mixSongId,
    hash: track.hash,
    savedAt: Date.now(),
  };
  saveLocalFavMap(map);
  return true;
}

function syncFavoriteButtonUi(track) {
  const liked = isQqovoTrack(track) && isLocalFavorite(track);
  const buttons = document.querySelectorAll('button[title="收藏"]');
  for (const btn of buttons) {
    btn.dataset.qqovoLocalFav = liked ? '1' : '0';
    btn.classList.toggle('qqovo-local-fav-on', liked);
    const svg = btn.querySelector('svg');
    if (svg) {
      svg.style.color = liked ? '#ef4444' : '';
      svg.style.fill = liked ? 'currentColor' : 'none';
    }
  }
}

function installLocalFavoriteInterceptor(ctx) {
  const onClick = (ev) => {
    const btn = ev.target?.closest?.('button[title="收藏"]');
    if (!btn) return;
    const track = ctx.stores?.player?.currentTrackSnapshot;
    if (!isQqovoTrack(track)) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation?.();
    const on = toggleLocalFavorite(track);
    syncFavoriteButtonUi(track);
    ctx.toast?.[on ? 'success' : 'info']?.(on ? '已加入本地收藏' : '已取消本地收藏');
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}

function openDownloadPanel(ctx, client, track) {
  if (!isQqovoTrack(track)) {
    ctx.toast?.info?.('当前不是 qqovo 音源歌曲');
    return;
  }
  const sourceId = track._qqovoSourceId || String(track.source || '').replace(`${PLUGIN_SOURCE_PREFIX}-`, '');
  const options = DOWNLOAD_QUALITY_OPTIONS[sourceId] || DOWNLOAD_QUALITY_OPTIONS.qq;
  const { vue } = ctx;
  const { ref, h } = vue;
  const busy = ref(false);
  const tip = ref('选择要下载的音质（最高会从顶档向下尝试）');

  const Panel = vue.defineComponent({
    setup(_, { emit }) {
      const close = () => emit('close');
      const onPick = async (opt) => {
        if (busy.value) return;
        busy.value = true;
        tip.value = `正在解析 ${opt.label}…`;
        try {
          const file = await fetchTrackBytes(ctx, client, track, opt.preference);
          const name = safeFileName(track.title || track.name, track.artist, file.ext);
          tip.value = `已拿到 ${file.quality || opt.label}，开始保存…`;
          triggerBrowserDownload(file.bytes, name, file.mime);
          ctx.toast?.info?.(`已开始下载：${name}`);
          close();
        } catch (e) {
          tip.value = e?.message || String(e);
          ctx.toast?.error?.(tip.value);
        } finally {
          busy.value = false;
        }
      };
      return () =>
        h('div', { class: 'qqovo-dl-mask', onClick: close }, [
          h(
            'div',
            {
              class: 'qqovo-dl-panel',
              onClick: (e) => e.stopPropagation(),
            },
            [
              h('div', { class: 'qqovo-dl-title' }, '下载音质'),
              h(
                'div',
                { class: 'qqovo-dl-sub' },
                `${track.title || ''} · ${track.artist || ''}`,
              ),
              h('div', { class: 'qqovo-dl-tip' }, tip.value),
              h(
                'div',
                { class: 'qqovo-dl-list' },
                options.map((opt) =>
                  h(
                    'button',
                    {
                      class: 'qqovo-dl-item',
                      disabled: busy.value,
                      onClick: () => void onPick(opt),
                    },
                    opt.label,
                  ),
                ),
              ),
              h(
                'button',
                { class: 'qqovo-dl-cancel', disabled: busy.value, onClick: close },
                '取消',
              ),
            ],
          ),
        ]);
    },
  });

  let dispose = null;
  const Host = vue.defineComponent({
    setup() {
      const open = ref(true);
      return () =>
        open.value
          ? h(Panel, {
              onClose: () => {
                open.value = false;
                dispose?.();
                dispose = null;
              },
            })
          : null;
    },
  });
  dispose = ctx.ui.teleport(Host);
}

/* ===================== UI ===================== */
function createPage(ctx, client) {
  const { vue } = ctx;
  const { ref, computed, h, onMounted, watch } = vue;

  const renderSongRow = (song, playOne) =>
    h(
      'div',
      {
        class: 'qqovo-song',
        onDblclick: () => void playOne(song, { queue: true }),
      },
      [
        song.coverUrl
          ? h('img', { class: 'qqovo-cover', src: song.coverUrl, loading: 'lazy' })
          : h('div', { class: 'qqovo-cover' }),
        h('div', { class: 'qqovo-meta' }, [
          h('div', { class: 'qqovo-song-title' }, song.title),
          h(
            'div',
            { class: 'qqovo-song-artist' },
            [song.artist, song.album, song._qqovoSourceId].filter(Boolean).join(' · '),
          ),
        ]),
        h('div', { class: 'qqovo-song-actions' }, [
          h(
            'button',
            {
              onClick: (e) => {
                e.stopPropagation();
                void playOne(song, { queue: true });
              },
            },
            '播放',
          ),
          h(
            'button',
            {
              class: 'ghost',
              onClick: (e) => {
                e.stopPropagation();
                void ctx.player.playNext(song);
                ctx.toast?.info?.('已加到下一首');
              },
            },
            '下一首',
          ),
        ]),
      ],
    );

  return vue.defineComponent({
    name: 'QqovoMusicPage',
    setup() {
      const sourceId = ref('qq');
      const view = ref('search');
      const keyword = ref('');
      const loading = ref(false);
      const error = ref('');
      const songs = ref([]);
      const charts = ref([]);
      const activeChart = ref(null);
      const fmMode = ref('DEFAULT');
      const status = ref('音源与音质优先 music.qqovo.cn');

      // 会话内缓存：切换音源/页签/模式只读缓存，点「搜索/换一批/刷新」才强制拉取
      const cache = {
        search: new Map(), // `${source}|${keyword}` -> songs
        lastSearch: new Map(), // source -> { keyword, songs, status }
        fm: new Map(), // `${source}|${mode}` -> songs
        lastFmMode: new Map(), // source -> mode
        charts: new Map(), // source -> charts[]
        chartSongs: new Map(), // `${kind}|${source}|${id}` -> { chart, songs }
        lastActiveChart: new Map(), // source -> chart|null
      };

      const sourceLabel = computed(
        () => SOURCE_DEFS.find((s) => s.id === sourceId.value)?.label || '',
      );
      const fmOptions = computed(() => fmModesOf(sourceId.value));

      const playOne = async (song, { queue = false } = {}) => {
        prefetchLyric(client, song);
        if (queue) {
          const list = songs.value.slice();
          const idx = list.findIndex((s) => s.id === song.id);
          const ordered = idx >= 0 ? [...list.slice(idx), ...list.slice(0, idx)] : [song];
          ordered.forEach((s) => prefetchLyric(client, s));
          await ctx.player.replaceQueueAndPlay(ordered, { requestedSong: song });
        } else {
          await ctx.player.playSong(song);
        }
      };

      const playAll = async () => {
        if (!songs.value.length) return;
        songs.value.forEach((s) => prefetchLyric(client, s));
        await ctx.player.replaceQueueAndPlay(songs.value);
      };

      const applySearchState = (src, q, list, statusText) => {
        keyword.value = q;
        songs.value = list;
        status.value = statusText;
        cache.search.set(`${src}|${q}`, list);
        cache.lastSearch.set(src, { keyword: q, songs: list, status: statusText });
      };

      const doSearch = async ({ force = true } = {}) => {
        const q = keyword.value.trim();
        if (!q) {
          error.value = '请输入关键词';
          return;
        }
        const src = sourceId.value;
        const key = `${src}|${q}`;
        if (!force && cache.search.has(key)) {
          const list = cache.search.get(key);
          applySearchState(
            src,
            q,
            list,
            list.length ? `找到 ${list.length} 首 · ${sourceLabel.value}（缓存）` : '无结果',
          );
          error.value = '';
          activeChart.value = null;
          return;
        }
        loading.value = true;
        error.value = '';
        activeChart.value = null;
        status.value = `正在搜索 ${sourceLabel.value}…`;
        try {
          const server = serverOf(src);
          // 搜索前先确保会话，失败时给出明确提示（避免只显示「无结果」）
          const warmOk = await client.warm();
          if (!warmOk) {
            error.value = 'qqovo 会话失败（bootstrap），请检查网络后重试';
            songs.value = [];
            status.value = '';
            return;
          }
          const raw = await client.search({ server, keyword: q });
          const list = raw.map((item) => songFromMeting(item, src)).filter(Boolean);
          applySearchState(
            src,
            q,
            list,
            list.length ? `找到 ${list.length} 首 · ${sourceLabel.value}` : '无结果',
          );
          if (!list.length && raw.length) {
            error.value = `上游返回 ${raw.length} 条但解析失败，请反馈`;
          }
        } catch (e) {
          error.value = e?.message || String(e);
          songs.value = [];
          status.value = '';
        } finally {
          loading.value = false;
        }
      };

      const loadFm = async ({ force = false } = {}) => {
        const src = sourceId.value;
        const mode = fmMode.value;
        const key = `${src}|${mode}`;
        const modeLabel = fmOptions.value.find((m) => m.value === mode)?.label || '漫游';
        activeChart.value = null;
        cache.lastFmMode.set(src, mode);

        if (!force && cache.fm.has(key)) {
          const list = cache.fm.get(key);
          songs.value = list;
          error.value = '';
          status.value = list.length
            ? `${modeLabel} · ${list.length} 首（缓存）`
            : '漫游暂无歌曲，可换模式或点换一批';
          return;
        }

        loading.value = true;
        error.value = '';
        status.value = `加载漫游 · ${sourceLabel.value}`;
        try {
          const server = serverOf(src);
          const target = 15;
          const rounds = src === 'netease' ? 6 : 3;
          const seen = new Set();
          const list = [];
          for (let i = 0; i < rounds && list.length < target; i += 1) {
            const raw = await client.fm({ server, mode, sourceId: src });
            for (const item of raw) {
              const song = songFromMeting(item, src);
              if (!song) continue;
              const dedupe = String(song._qqovoId || song.id);
              if (seen.has(dedupe)) continue;
              seen.add(dedupe);
              list.push(song);
              if (list.length >= target) break;
            }
          }
          if (src === 'netease') await enrichNeteaseCovers(client, list);
          cache.fm.set(key, list);
          songs.value = list;
          status.value = list.length
            ? `${modeLabel} · ${list.length} 首`
            : '漫游暂无歌曲，可换模式或点换一批';
        } catch (e) {
          error.value = e?.message || String(e);
          songs.value = [];
          status.value = '';
        } finally {
          loading.value = false;
        }
      };

      const loadChartList = async ({ force = false } = {}) => {
        const src = sourceId.value;
        songs.value = [];
        activeChart.value = null;
        cache.lastActiveChart.set(src, null);

        if (!force && cache.charts.has(src)) {
          charts.value = cache.charts.get(src);
          error.value = '';
          status.value = `${charts.value.length} 个榜单 · ${sourceLabel.value}（缓存）`;
          return;
        }

        loading.value = true;
        error.value = '';
        status.value = '加载排行榜…';
        try {
          const list = [];
          let hotCover = '';
          try {
            const hotPreview = await client.getPlatformHot(1);
            if (hotPreview[0]) hotCover = httpsify(hotPreview[0].pic || '');
          } catch {}
          list.push({
            id: PLATFORM_HOT_ID,
            name: '平台热榜',
            cover: hotCover,
            group: 'OpenMusic',
            sourceId: src,
            kind: 'platform-hot',
          });

          if (src === 'netease') {
            for (const c of NETEASE_CHARTS) {
              list.push({
                id: c.id,
                name: c.name,
                cover: '',
                group: '官方榜',
                sourceId: 'netease',
                kind: 'netease-playlist',
              });
            }
          } else {
            const chartsFromDl = await client.listMusicdlToplists(src);
            list.push(...chartsFromDl);
          }
          cache.charts.set(src, list);
          charts.value = list;
          status.value = `${list.length} 个榜单 · ${sourceLabel.value}`;
        } catch (e) {
          error.value = e?.message || String(e);
          charts.value = [];
          status.value = '';
        } finally {
          loading.value = false;
        }
      };

      const chartSongsKey = (chart) =>
        `${chart.kind}|${chart.sourceId || sourceId.value}|${chart.id}`;

      const openChart = async (chart, { force = false } = {}) => {
        const src = sourceId.value;
        const key = chartSongsKey(chart);
        activeChart.value = chart;
        cache.lastActiveChart.set(src, chart);

        if (!force && cache.chartSongs.has(key)) {
          const hit = cache.chartSongs.get(key);
          songs.value = hit.songs;
          error.value = '';
          status.value = hit.songs.length
            ? `${chart.name} · ${hit.songs.length} 首（缓存）`
            : `${chart.name} 暂无曲目`;
          return;
        }

        loading.value = true;
        error.value = '';
        status.value = `加载 ${chart.name}…`;
        try {
          let list = [];
          if (chart.kind === 'platform-hot') {
            const raw = await client.getPlatformHot(50);
            list = raw.map(songFromPlatformHot).filter(Boolean);
          } else if (chart.kind === 'netease-playlist') {
            const raw = await client.playlist({ server: 'netease', id: chart.id });
            list = raw.map((item) => songFromMeting(item, 'netease')).filter(Boolean);
          } else {
            const raw = await client.musicdlToplistSongs(chart.sourceId, chart.id, 50);
            list = raw.map((item) => songFromMusicdl(item, chart.sourceId)).filter(Boolean);
          }
          cache.chartSongs.set(key, { chart, songs: list });
          songs.value = list;
          status.value = list.length
            ? `${chart.name} · ${list.length} 首`
            : `${chart.name} 暂无曲目`;
        } catch (e) {
          error.value = e?.message || String(e);
          songs.value = [];
          status.value = '';
        } finally {
          loading.value = false;
        }
      };

      const restoreSearchView = () => {
        activeChart.value = null;
        const src = sourceId.value;
        const last = cache.lastSearch.get(src);
        if (last) {
          keyword.value = last.keyword;
          songs.value = last.songs;
          status.value = last.songs?.length
            ? `找到 ${last.songs.length} 首 · ${sourceLabel.value}（缓存）`
            : last.status || '无结果';
        } else {
          songs.value = [];
          status.value = '输入关键词搜索';
        }
      };

      const restoreFmView = () => {
        const src = sourceId.value;
        const savedMode = cache.lastFmMode.get(src);
        if (savedMode && fmOptions.value.some((m) => m.value === savedMode)) {
          fmMode.value = savedMode;
        } else if (!fmOptions.value.some((m) => m.value === fmMode.value)) {
          fmMode.value = 'DEFAULT';
        }
        void loadFm({ force: false });
      };

      const restoreChartsView = () => {
        const src = sourceId.value;
        const lastChart = cache.lastActiveChart.get(src);
        void loadChartList({ force: false }).then(() => {
          if (lastChart) {
            const still = charts.value.find(
              (c) => c.id === lastChart.id && c.kind === lastChart.kind,
            );
            if (still) void openChart(still, { force: false });
          }
        });
      };

      const switchView = (next) => {
        if (view.value === next) return;
        view.value = next;
        error.value = '';
        if (next === 'fm') restoreFmView();
        else if (next === 'charts') restoreChartsView();
        else restoreSearchView();
      };

      watch(sourceId, () => {
        error.value = '';
        if (view.value === 'fm') restoreFmView();
        else if (view.value === 'charts') restoreChartsView();
        else restoreSearchView();
      });

      onMounted(() => {
        void client.warm().then((ok) => {
          if (ok) status.value = 'qqovo 会话已就绪 · music.qqovo.cn';
        });
      });

      const toolbarExtra = () => {
        if (view.value === 'search') {
          return h('div', { class: 'qqovo-search-row' }, [
            h('input', {
              value: keyword.value,
              placeholder: `搜索${sourceLabel.value}歌曲`,
              onInput: (e) => {
                keyword.value = e.target.value;
              },
              onKeydown: (e) => {
                if (e.key === 'Enter') void doSearch({ force: true });
              },
            }),
            h(
              'button',
              { disabled: loading.value, onClick: () => void doSearch({ force: true }) },
              loading.value ? '搜索中' : '搜索',
            ),
            songs.value.length
              ? h('button', { class: 'ghost', onClick: () => void playAll() }, '播放全部')
              : null,
          ]);
        }
        if (view.value === 'fm') {
          return h('div', { class: 'qqovo-fm-block' }, [
            h(
              'div',
              { class: 'qqovo-tabs qqovo-fm-modes' },
              fmOptions.value.map((m) =>
                h(
                  'button',
                  {
                    class: ['qqovo-tab', fmMode.value === m.value ? 'is-active' : ''].filter(
                      Boolean,
                    ),
                    title: m.description || m.label,
                    onClick: () => {
                      if (fmMode.value === m.value) return;
                      fmMode.value = m.value;
                      void loadFm({ force: false });
                    },
                  },
                  m.label,
                ),
              ),
            ),
            h('div', { class: 'qqovo-search-row' }, [
              h(
                'button',
                {
                  disabled: loading.value,
                  onClick: () => void loadFm({ force: true }),
                },
                loading.value ? '刷新中' : '换一批',
              ),
              songs.value.length
                ? h('button', { class: 'ghost', onClick: () => void playAll() }, '播放全部')
                : null,
            ]),
          ]);
        }
        // charts
        return h('div', { class: 'qqovo-search-row' }, [
          activeChart.value
            ? h(
                'button',
                {
                  class: 'ghost',
                  onClick: () => {
                    activeChart.value = null;
                    cache.lastActiveChart.set(sourceId.value, null);
                    songs.value = [];
                    const cached = cache.charts.get(sourceId.value);
                    if (cached) charts.value = cached;
                    status.value = `${charts.value.length} 个榜单 · ${sourceLabel.value}（缓存）`;
                  },
                },
                '← 返回榜单',
              )
            : h(
                'button',
                {
                  disabled: loading.value,
                  onClick: () => void loadChartList({ force: true }),
                },
                loading.value ? '加载中' : '刷新榜单',
              ),
          activeChart.value
            ? h(
                'button',
                {
                  class: 'ghost',
                  disabled: loading.value,
                  onClick: () => void openChart(activeChart.value, { force: true }),
                },
                '刷新曲目',
              )
            : null,
          songs.value.length
            ? h('button', { class: 'ghost', onClick: () => void playAll() }, '播放全部')
            : null,
        ]);
      };

      const mainBody = () => {
        if (view.value === 'charts' && !activeChart.value) {
          if (!charts.value.length) {
            return h(
              'div',
              { class: 'qqovo-empty' },
              loading.value ? '加载榜单…' : '暂无榜单',
            );
          }
          return h(
            'div',
            { class: 'qqovo-chart-grid' },
            charts.value.map((chart) =>
              h(
                'button',
                {
                  class: [
                    'qqovo-chart-card',
                    chart.kind === 'platform-hot' ? 'is-hot' : '',
                  ].filter(Boolean),
                  onClick: () => void openChart(chart),
                },
                [
                  chart.cover
                    ? h('img', { class: 'qqovo-chart-cover', src: chart.cover, loading: 'lazy' })
                    : h('div', { class: 'qqovo-chart-cover qqovo-chart-cover--empty' }, '♪'),
                  h('div', { class: 'qqovo-chart-meta' }, [
                    h('div', { class: 'qqovo-chart-name' }, chart.name),
                    h(
                      'div',
                      { class: 'qqovo-chart-group' },
                      chart.group || (chart.kind === 'platform-hot' ? '全平台热播' : sourceLabel.value),
                    ),
                  ]),
                ],
              ),
            ),
          );
        }

        if (!songs.value.length) {
          const emptyHint =
            view.value === 'fm'
              ? '点「换一批」或切换漫游模式'
              : view.value === 'charts'
                ? '选择一个榜单查看曲目'
                : '输入关键词搜索。播链与歌词走 music.qqovo.cn';
          return h(
            'div',
            { class: 'qqovo-empty' },
            loading.value ? '加载中…' : emptyHint,
          );
        }
        return h(
          'div',
          { class: 'qqovo-list' },
          songs.value.map((song) => renderSongRow(song, playOne)),
        );
      };

      return () =>
        h('div', { class: 'qqovo-page' }, [
          h('div', { class: 'qqovo-header' }, [
            h('div', { class: 'qqovo-title-row' }, [
              h('h2', { class: 'qqovo-title' }, 'QQ / 网易 / 汽水'),
              h('p', { class: 'qqovo-sub' }, '漫游 · 排行 · qqovo 音质'),
            ]),
            h(
              'div',
              { class: 'qqovo-tabs' },
              VIEW_TABS.map((t) =>
                h(
                  'button',
                  {
                    class: ['qqovo-tab', view.value === t.id ? 'is-active' : ''].filter(Boolean),
                    onClick: () => switchView(t.id),
                  },
                  t.label,
                ),
              ),
            ),
            h(
              'div',
              { class: 'qqovo-tabs' },
              SOURCE_DEFS.map((s) =>
                h(
                  'button',
                  {
                    class: ['qqovo-tab', sourceId.value === s.id ? 'is-active' : ''].filter(Boolean),
                    onClick: () => {
                      sourceId.value = s.id;
                    },
                  },
                  s.label,
                ),
              ),
            ),
            toolbarExtra(),
            h(
              'div',
              { class: ['qqovo-status', error.value ? 'is-error' : ''].filter(Boolean) },
              error.value || status.value,
            ),
          ]),
          mainBody(),
        ]);
    },
  });
}

/* ===================== activate ===================== */
let _client = null;

export async function activate(ctx) {
  if (ctx.manifest.capabilities?.unrestrictedNetwork !== true) {
    ctx.toast?.error?.('需要 unrestrictedNetwork 能力');
  }
  if (ctx.manifest.capabilities?.webServer !== true) {
    ctx.toast?.error?.('汽水播放需要 webServer 能力，请检查插件权限');
  }
  SESSION.byBase.clear();
  const client = createQqovoClient(ctx.net);
  _client = client;
  void client.warm().then((ok) => {
    if (ok) console.info('[qqovo-music] session warm ok v' + (ctx.manifest?.version || ''));
    else ctx.toast?.warning?.('qqovo 会话初始化失败，稍后重试播放');
  });
  ctx.toast?.info?.(`qqovo 插件已加载 v${ctx.manifest?.version || '?'}`);

  ctx.player.audioSource.register({
    id: 'qqovo-url',
    position: 'before-catalog',
    order: 20,
    match: ({ track }) => isQqovoTrack(track),
    resolve: async ({ track, quality }) => {
      const { server, id } = getTrackMeta(track);
      if (!server || !id) return null;
      prefetchLyric(client, track, ctx);
      try {
        const preference = mapEchoQuality(quality);
        const hit = await client.resolveHit({ server, id, preference });
        if (!hit?.url) {
          console.warn('[qqovo-music] resolve empty', server, id, preference);
          return null;
        }

        let url = hit.url;
        if (server === 'qishui') {
          if (!hit.auth) throw new Error('汽水缺少解密参数');
          const cacheKey = `${id}:${hit.quality || hit.requestedQuality || preference}`;
          url = await materializeQishui(ctx, client, hit.url, hit.auth, cacheKey);
        }

        // 当前曲就绪后预取后续 1 首
        try {
          const qualityHint =
            quality ||
            ctx.player?.audioQuality?.value?.effective ||
            ctx.stores?.player?.getEffectiveAudioQuality?.() ||
            '320';
          for (const next of collectPrefetchTracks(ctx.stores?.playlist, track, 1)) {
            prefetchTrackPlayback(ctx, client, next, qualityHint);
            prefetchLyric(client, next, ctx);
          }
        } catch {}

        return {
          url,
          quality: mapResolvedQuality(server, hit.quality || hit.requestedQuality || preference),
          effect: 'none',
          sourceKind: 'plugin',
        };
      } catch (e) {
        console.error('[qqovo-music] audio resolve failed', server, id, e);
        ctx.toast?.danger?.(e?.message || String(e));
        return null;
      }
    },
  });

  ctx.lyrics.registerResolver({
    id: 'qqovo-lrc',
    order: 30,
    match: ({ track }) => isQqovoTrack(track),
    resolve: async ({ track }) => {
      const { server, id } = getTrackMeta(track);
      if (!server || !id) return null;
      const cacheKey = `${server}:${id}`;
      // 宿主歌词 resolver 硬超时 2.5s，超时会弹「插件运行异常」。
      // 只返回已缓存歌词；未命中则后台拉取，绝不在 resolve 里等网络。
      if (LYRIC_CACHE.has(cacheKey)) {
        return { decodeContent: LYRIC_CACHE.get(cacheKey), source: 'qqovo' };
      }
      prefetchLyric(client, track, ctx);
      return null;
    },
  });

  // 切歌时预取歌词 + 下一曲播链；不同时预解密当前曲（resolve 负责，避免并发抢带宽）
  const stopWatch = ctx.vue.watch(
    () => ctx.stores.player.currentTrackSnapshot,
    (track) => {
      if (isQqovoTrack(track)) {
        prefetchLyric(client, track, ctx);
        const qualityHint =
          ctx.player?.audioQuality?.value?.effective ||
          ctx.stores?.player?.getEffectiveAudioQuality?.() ||
          '320';
        for (const next of collectPrefetchTracks(ctx.stores?.playlist, track, 1)) {
          prefetchTrackPlayback(ctx, client, next, qualityHint);
          prefetchLyric(client, next, ctx);
        }
      }
      syncFavoriteButtonUi(track);
    },
    { immediate: true },
  );
  ctx.dispose(stopWatch);

  const stopFavClick = installLocalFavoriteInterceptor(ctx);
  ctx.dispose(stopFavClick);

  ctx.ui.addSongContextMenuItem({
    id: 'qqovo-download',
    label: '下载（选音质）',
    order: 40,
    visible: (song) => isQqovoTrack(song),
    onSelect: (song) => openDownloadPanel(ctx, client, song),
  });

  // 播放栏下载按钮（当前曲为 qqovo 时显示）
  const DlBtn = ctx.vue.defineComponent({
    setup() {
      const visible = ctx.vue.computed(() => isQqovoTrack(ctx.stores.player.currentTrackSnapshot));
      return () =>
        visible.value
          ? ctx.vue.h(
              'button',
              {
                class: 'qqovo-player-dl',
                title: '下载当前歌曲（可选音质）',
                onClick: () =>
                  openDownloadPanel(ctx, client, ctx.stores.player.currentTrackSnapshot),
              },
              '下载',
            )
          : null;
    },
  });
  // 只挂到实际存在的播放栏节点；缺失目标勿调用 mount（宿主会记「插件运行异常」）
  const mountTargets = ['.player-actions', '.player-bar-actions', '.now-playing-actions'];
  for (const sel of mountTargets) {
    if (!document.querySelector(sel)) continue;
    try {
      ctx.ui.mount(sel, DlBtn, { position: 'append', className: 'qqovo-player-dl-host' });
    } catch {}
  }

  ctx.ui.addPage({
    id: 'search',
    title: 'QQ/网易/汽水',
    icon: 'tabler:music-search',
    component: createPage(ctx, client),
    sidebar: {
      section: 'plugins',
      sectionTitle: '插件',
      order: 40,
    },
  });

  ctx.ui.settings.define({
    title: 'QQ / 网易 / 汽水',
    description: '音质与歌词优先 music.qqovo.cn；汽水需本地解密。仅供学习交流。',
    component: ctx.vue.defineComponent({
      setup() {
        return () =>
          ctx.vue.h('div', { style: 'padding:12px;line-height:1.6;font-size:13px;opacity:.85' }, [
            ctx.vue.h('p', null, '本插件将 md3Music 的 qqovo 发现音源移植到 EchoMusic。'),
            ctx.vue.h('p', null, '· 搜索 / 漫游 / 播链 / 歌词：music.qqovo.cn'),
            ctx.vue.h('p', null, '· 排行榜：平台热榜（qqovo）+ QQ/汽水榜（musicdl 目录）+ 网易官方榜'),
            ctx.vue.h('p', null, '· 汽水：AES-CTR 解密后经本机 HTTP（Range）播放'),
            ctx.vue.h('p', null, '· 播放栏「下载」可选音质（含最高）；右键菜单也可下载'),
            ctx.vue.h('p', null, '· qqovo 曲收藏写入插件本地（宿主云收藏仅支持酷狗）'),
            ctx.vue.h('p', null, '· 无官方账号登录；仅供学习交流'),
          ]);
      },
    }),
  });

  ctx.dispose(() => {
    for (const url of PLAY_URL_CACHE.values()) {
      if (String(url).startsWith('blob:')) {
        try {
          URL.revokeObjectURL(url);
        } catch {}
      }
    }
    PLAY_URL_CACHE.clear();
    QISHUI_FILES.clear();
    qishuiServerOrigin = '';
    _client = null;
  });
}

export function deactivate() {
  for (const url of PLAY_URL_CACHE.values()) {
    if (String(url).startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
  }
  PLAY_URL_CACHE.clear();
  QISHUI_FILES.clear();
  LYRIC_CACHE.clear();
  RESOLVE_HIT_CACHE.clear();
  PREFETCH_INFLIGHT.clear();
  SESSION.byBase.clear();
  qishuiServerOrigin = '';
  _client = null;
}
