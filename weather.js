/**
 * China-only weather lookup.
 *
 * Data sources (all free, no API key):
 * - Photon / OpenStreetMap: Chinese place geocoding (county/district level).
 * - ipip.net: Chinese province/city names for the host's public IP.
 * - ipwho.is: coordinates and country for the host's public IP.
 * - Open-Meteo: weather forecast and air quality.
 */

const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';
const GEOCODE_FALLBACK_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const AIR_ENDPOINT = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const IPIP_ENDPOINT = 'https://myip.ipip.net/json';
const IPWHO_ENDPOINT = 'https://ipwho.is/';

/**
 * 地名类型权重（2026-11-17 加）。
 *
 * 起因：`天门` 在 Photon 里能搜到 7 个同名条目，分别是
 *   天门市/湖北省(place/city) · 天门/新疆(tourism/attraction) · 天门/浙江(natural/peak)
 *   天门/安徽(place/village) · 天门/江西(place/hamlet) · 天门/浙江(place/locality)
 *   天门镇/安徽(place/town)
 * normalizeName 会把 `天门市` 规约成 `天门`，于是这 7 条 **nameScore 全是 100**，
 * 排序只能靠 Photon 的返回顺序——这次恰好对，但那是运气，不是逻辑。
 *
 * 加这张表之后：城市级 > 镇 > 县/区 > 村 > 自然/旅游要素。
 * 「天门」现在由 place/city 稳定胜出（130 分 vs 75 分），不再依赖运气。
 */
const SETTLEMENT_RANK = new Map([
  ['city', 30],
  ['municipality', 30],
  ['county', 26],
  ['borough', 14],
  ['town', 20],
  ['district', 16],
  ['suburb', 12],
  ['village', 8],
  ['hamlet', 5],
  ['locality', 4],
  ['quarter', 3],
  ['neighbourhood', 2],
]);

/** 非居民点（山、景点、桥……）在"查天气"这个语境里是噪音，扣分 */
const NON_SETTLEMENT_PENALTY = 25;

const AMAP_ENDPOINT = 'https://restapi.amap.com/v3/geocode/geo';
const AMAP_TIMEOUT_MS = 8_000;

const USER_AGENT = 'dsh-weather-cn/1.0 (personal weather tool)';
const CHINA_CODES = new Set(['CN', 'HK', 'MO', 'TW']);
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 64;
const REQUEST_TIMEOUT_MS = 12_000;
const PHOTON_TIMEOUT_MS = 11_000;
const FAST_GEOCODE_MS = 3_200;

const WMO_TEXT = new Map([
  [0, '晴'],
  [1, '晴间多云'],
  [2, '多云'],
  [3, '阴'],
  [45, '雾'],
  [48, '雾凇'],
  [51, '小毛毛雨'],
  [53, '毛毛雨'],
  [55, '大毛毛雨'],
  [56, '冻毛毛雨'],
  [57, '强冻毛毛雨'],
  [61, '小雨'],
  [63, '中雨'],
  [65, '大雨'],
  [66, '冻雨'],
  [67, '强冻雨'],
  [71, '小雪'],
  [73, '中雪'],
  [75, '大雪'],
  [77, '米雪'],
  [80, '阵雨'],
  [81, '强阵雨'],
  [82, '暴雨'],
  [85, '阵雪'],
  [86, '强阵雪'],
  [95, '雷阵雨'],
  [96, '雷阵雨伴冰雹'],
  [99, '强雷暴伴冰雹'],
]);

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

function round1(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined;
}

function cjkPart(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  const first = text.split(/\s+/)[0];
  return /[\u4e00-\u9fff]/.test(first) ? first : text;
}

function normalizeName(value) {
  return cjkPart(value)
    .replace(/\s+/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/(特别行政区|自治区|自治州|地区|新区|省|市|区|县|旗|盟)$/g, '');
}

function isChinaCode(code) {
  return CHINA_CODES.has(String(code ?? '').toUpperCase());
}

function weatherText(code) {
  return WMO_TEXT.get(code) ?? '未知';
}

function windText(degree) {
  if (typeof degree !== 'number' || !Number.isFinite(degree)) return undefined;
  const sectors = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return `${sectors[Math.round(((degree % 360) / 45)) % 8]}风`;
}

function timePart(value) {
  if (typeof value !== 'string') return undefined;
  const index = value.indexOf('T');
  return index >= 0 ? value.slice(index + 1, index + 6) : value;
}

function weekdayOf(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : WEEKDAYS[parsed.getUTCDay()];
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (degree) => (degree * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchJson(url, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('上游请求超时')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await withTimeout(
      fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: combined,
      }),
      timeoutMs,
      '上游请求超时',
    );
    if (!response.ok) throw new Error(`上游服务返回 HTTP ${response.status}`);
    return await withTimeout(response.json(), timeoutMs, '上游响应解析超时');
  } finally {
    clearTimeout(timer);
  }
}

/** Split a Chinese place string into the most specific lookup candidates. */
function placeCandidates(raw) {
  const text = raw
    .trim()
    .replace(/^中华人民共和国/, '')
    .replace(/^中国(?:大陆)?/, '')
    .replace(/[\s,，、]+/g, '');
  if (!text) return [];

  const withoutProvince = text.replace(/^(.{2,}?(?:省|自治区|特别行政区))/, '');
  const core = withoutProvince && withoutProvince !== text ? withoutProvince : text;

  const candidates = [];
  const add = (value) => {
    const item = value?.trim();
    if (item && item.length >= 2 && !candidates.includes(item)) candidates.push(item);
  };

  const district = core.match(/([^省市州盟县区旗]{1,}(?:区|县|旗))$/);
  if (district && district[1] !== core) add(district[1]);

  const city = core.match(/^(.{2,}?(?:市|自治州|地区|盟))/);
  if (city) add(city[1]);

  add(core);
  if (core !== text) add(text);

  let stripped = text;
  for (let index = 0; index < 4; index += 1) {
    const next = stripped.replace(/(特别行政区|自治区|自治州|地区|新区|省|市|区|县|旗|盟)$/, '');
    if (!next || next === stripped) break;
    stripped = next;
    add(stripped);
  }

  const cityIndex = text.indexOf('市');
  if (cityIndex >= 0 && cityIndex + 1 < text.length) add(text.slice(cityIndex + 1));

  return candidates.slice(0, 5);
}

/** Score one Photon feature against the query and its administrative context. */
function scoreFeature(feature, query, candidates, context, bias) {
  const props = feature.properties ?? {};
  const name = normalizeName(props.name);
  const queryName = normalizeName(query);
  const fields = [props.state, props.city, props.county, props.district].map(normalizeName).filter(Boolean);

  const placeLike =
    props.osm_key === 'boundary' ||
    (props.osm_key === 'place' &&
      ['city', 'town', 'village', 'municipality', 'county', 'district', 'suburb', 'quarter', 'neighbourhood', 'locality'].includes(
        props.osm_value,
      ));

  let nameScore = 0;
  if (name && queryName && name === queryName) nameScore = 100;
  else if (placeLike && name && queryName && (name.includes(queryName) || queryName.includes(name))) nameScore = 35;

  // ★ 2026-11-17：按地名要素类型排名。城市级压倒性胜出，山头/景点/桥被压下去。
  //   boundary/administrative（行政区边界）没有 osm_value 可查，按区县级 16 分算 ——
  //   否则「北京市朝阳区」这种正确结果会因为 rank=0 被误判成低置信度。
  const rank = placeLike
    ? (SETTLEMENT_RANK.get(String(props.osm_value)) ?? (props.osm_key === 'boundary' ? 16 : 0))
    : 0;
  let score = nameScore + rank;
  if (rank === 0 && nameScore > 0) score -= NON_SETTLEMENT_PENALTY;

  for (const other of candidates) {
    const token = normalizeName(other);
    if (!token || token === queryName) continue;
    if (fields.some((field) => field.includes(token) || token.includes(field))) score += 12;
  }

  if (context) {
    const province = normalizeName(context.province);
    if (province && fields.some((field) => field.includes(province))) score += 20;
  }

  if (bias && Number.isFinite(bias.latitude) && Number.isFinite(bias.longitude)) {
    const [lon, lat] = feature.geometry?.coordinates ?? [];
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      score += Math.max(0, 25 - distanceKm(bias.latitude, bias.longitude, lat, lon) / 15);
    }
  }

  return { score, nameScore, rank };
}

function featureToPlace(feature) {
  const props = feature.properties ?? {};
  const [lon, lat] = feature.geometry?.coordinates ?? [];
  const name = cjkPart(props.name);
  const admin1 = cjkPart(props.state);
  const admin2 = cjkPart(props.city) || cjkPart(props.county);
  const pieces = [admin1, admin2, name].filter((part, index, all) => {
    if (!part) return false;
    if (index === 0) return true;
    const previous = all.slice(0, index).filter(Boolean);
    return !previous.some((item) => item.includes(part) || part.includes(item));
  });

  return {
    name,
    admin1,
    admin2,
    display: pieces.join('') || name || '未知地区',
    latitude: lat,
    longitude: lon,
    countryCode: String(props.countrycode ?? '').toUpperCase(),
  };
}

/** City-level fallback geocoder used when Photon is slow or unavailable. */
async function geocodeOpenMeteo(raw, signal) {
  const url = new URL(GEOCODE_FALLBACK_ENDPOINT);
  url.searchParams.set('name', raw);
  url.searchParams.set('count', '10');
  url.searchParams.set('language', 'zh');
  url.searchParams.set('format', 'json');

  const data = await fetchJson(url, { signal, timeoutMs: 8_000 });
  const results = (data?.results ?? []).filter((item) => isChinaCode(item.country_code));
  if (results.length === 0) return undefined;

  const ranked = results
    .map((item) => ({
      item,
      exact: normalizeName(item.name) === normalizeName(raw) ? 1 : 0,
      population: Number.isFinite(item.population) ? item.population : 0,
    }))
    .sort((left, right) => right.exact - left.exact || right.population - left.population);
  if (ranked[0].exact === 0) return undefined;

  const best = ranked[0].item;
  // 去重：直辖市经常 admin1 和 admin2 都返回"上海市"，拼出来会变成「上海市上海市」。
  const pieces = [...new Set([best.admin1, best.admin2].filter(Boolean))];
  if (!pieces.some((part) => part.includes(best.name))) pieces.push(best.name);

  return {
    name: best.name,
    admin1: best.admin1 ?? '',
    admin2: best.admin2 ?? '',
    display: pieces.join(''),
    latitude: best.latitude,
    longitude: best.longitude,
    countryCode: best.country_code,
    // ★ 2026-11-17：把人口带出来当作"这条路可信吗"的判据，见 geocode() 里的注释。
    //   调用方接受前会用 withoutPopulation() 剥掉，不会漏到对外的 place 对象上。
    population: ranked[0].population,
  };
}

/** 剥掉仅供内部置信度判断的字段 */
const withoutPopulation = ({ population, ...place }) => place;

/**
 * 高德地理编码（可选路径，默认关闭）。
 *
 * 中国境内县级市/乡镇的数据质量明显好于 OpenStreetMap 系（Photon 里宜昌的
 * 县级市也会缺人口、同名村一堆）。但高德要免费 key，所以做成"配了才走"：
 * 环境变量 `AMAP_KEY` 有值就优先用它，没配就整段跳过，不影响其它路径。
 *
 * 注册：https://lbs.amap.com/ → 控制台 → 应用管理 → 添加 Key → Web服务
 */
/** 省级名称（用于从裸地名里榨出"用户其实说了哪个省"这条线索） */
const PROVINCE_NAMES = [
  '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南',
  '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾',
  '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门',
];

/**
 * 从用户输入里找省级线索。
 * 「北京市朝阳区」→ 北京（于是海淀/朝阳这种同名区能按省份定死）
 * 「湖北省天门市」→ 湖北
 * 「天门」        → ''（没有线索，只能靠地名等级猜）
 */
function detectProvince(raw) {
  const text = String(raw ?? '');
  // 长的优先，避免"海南"被"南"之类误伤（这里没有单字项，但保持稳妥）
  let best = '';
  for (const name of PROVINCE_NAMES) {
    if (text.includes(name) && name.length > best.length) best = name;
  }
  return best;
}

async function geocodeAmap(raw, signal) {
  const key = String(process.env.AMAP_KEY ?? '').trim();
  if (!key) return undefined;

  const url = new URL(AMAP_ENDPOINT);
  url.searchParams.set('address', raw);
  url.searchParams.set('key', key);
  url.searchParams.set('output', 'JSON');

  const data = await fetchJson(url, { signal, timeoutMs: AMAP_TIMEOUT_MS });
  if (String(data?.status ?? '') !== '1') return undefined;
  const first = Array.isArray(data?.geocodes) ? data.geocodes[0] : undefined;
  if (!first) return undefined;

  const [lngRaw, latRaw] = String(first.location ?? '').split(',');
  const longitude = Number(lngRaw);
  const latitude = Number(latRaw);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;

  // 高德对直辖市会把 city 返回成 []（数组），这里统一兜成空串。
  const province = Array.isArray(first.province) ? '' : String(first.province ?? '');
  const city = Array.isArray(first.city) ? '' : String(first.city ?? '');
  const district = Array.isArray(first.district) ? '' : String(first.district ?? '');
  const pieces = [province, city, district].filter((p, i, all) => p && all.indexOf(p) === i);
  const display = pieces.join('') || String(first.formatted_address ?? raw);
  const name = String(district || city || province || raw).replace(/(市|区|县|旗|盟)$/, '');

  return {
    name,
    admin1: province,
    admin2: city || district,
    display,
    latitude,
    longitude,
    countryCode: 'CN',
    geocoder: 'amap',
    confidence: 'high',
  };
}

async function geocode(raw, { context, bias, signal } = {}) {
  const cacheKey = `geo:${normalizeName(raw) || raw.toLowerCase()}:${context?.province ?? ''}:${
    bias ? `${bias.latitude?.toFixed(1)},${bias.longitude?.toFixed(1)}` : ''
  }`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const candidates = placeCandidates(raw);
  if (!candidates.length) throw new Error('地区名无效，请提供中国境内的城市或区县名称。');

  // 用户输入里如果带了省名（「北京市朝阳区」「湖北省天门市」），那就是最硬的消歧线索：
  // 命中该省的候选 +20 分，且最终置信度直接判 high —— 人家已经说清楚了，不该再提示"有歧义"。
  const provinceHint = detectProvince(raw);
  const effectiveContext = context ?? (provinceHint ? { province: provinceHint } : undefined);

  // ⓪ 高德（配了 AMAP_KEY 才走）：中国境内最准，直接采信。
  const amap = await geocodeAmap(raw, signal).catch(() => undefined);
  if (amap) return cacheSet(cacheKey, amap);

  // ① 快路径：Open-Meteo 常见城市名 ~1 秒返回。
  const fallbackPromise = geocodeOpenMeteo(raw, signal).catch(() => undefined);
  const fast = await withTimeout(fallbackPromise, FAST_GEOCODE_MS, 'fast geocode timeout').catch(
    () => undefined,
  );
  // ★ 2026-11-17 修（主人实测「天门」被解析到黑龙江哈尔滨市天门）：
  //   geocoding-api.open-meteo.com 里**根本没有湖北天门**——查 `天门` 返回 6 条同名结果，
  //   全在黑龙江/山西/重庆/四川/甘肃，population 清一色 0。人口全 0 时排序退化，
  //   于是第一条（黑龙江那个村子）就被当成答案。
  //   Photon 那边 `天门市 / 湖北省` 恰好是第一条，所以：fast 结果人口为 0 = 不可信，
  //   交给 Photon 走完整打分；Photon 也不行时再退回 fast（见下面的 fallback）。
  if (fast && fast.population > 0) {
    const place = withoutPopulation(fast);
    // 人口 > 5 万才算有分量的城市；几千人的镇子给 medium，跟用户说一声更保险。
    return cacheSet(cacheKey, {
      ...place,
      geocoder: 'open-meteo',
      confidence: fast.population >= 50_000 ? 'high' : 'medium',
    });
  }

  const collected = [];
  let sawForeign = false;
  let photonError;

  try {
    for (const query of candidates.slice(0, 3)) {
      const url = new URL(PHOTON_ENDPOINT);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '8');
      if (bias && Number.isFinite(bias.latitude) && Number.isFinite(bias.longitude)) {
        url.searchParams.set('lat', String(bias.latitude));
        url.searchParams.set('lon', String(bias.longitude));
      }

      const data = await fetchJson(url, { signal, timeoutMs: PHOTON_TIMEOUT_MS });
      const features = Array.isArray(data?.features) ? data.features : [];
      if (features.some((feature) => !isChinaCode(feature.properties?.countrycode))) sawForeign = true;

      const china = features.filter((feature) => isChinaCode(feature.properties?.countrycode));
      china.forEach((feature, index) => {
        const scored = scoreFeature(feature, query, candidates, effectiveContext, bias);
        if (scored.nameScore > 0) {
          collected.push({
            feature,
            query,
            index,
            score: scored.score,
            nameScore: scored.nameScore,
            rank: scored.rank,
          });
        }
      });

      if (china.some((feature) => normalizeName(feature.properties?.name) === normalizeName(query))) break;
    }
  } catch (error) {
    photonError = error;
  }

  if (collected.length === 0 && !sawForeign) {
    const fallback = await fallbackPromise;
    if (fallback) {
      // ★ 这条是"两条正路都断了"的兜底：结果可能错，所以必须标 low 并让人看见。
      return cacheSet(cacheKey, {
        ...withoutPopulation(fallback),
        geocoder: 'open-meteo',
        confidence: 'low',
      });
    }
  }

  if (!collected.length) {
    if (sawForeign) {
      throw new Error(`“${raw}”不在中国境内。本工具仅支持中国境内（含港澳台）地区。`);
    }
    if (photonError) {
      throw new Error('地名解析服务暂时不可用，请稍后重试，或换用更常见的城市名。');
    }
    throw new Error(`未找到中国境内的“${raw}”，请换用城市名（如“杭州”“乌鲁木齐”）或加上省份。`);
  }

  collected.sort((left, right) => right.score - left.score || left.index - right.index);
  const best = collected[0];
  const runner = collected[1];
  const gap = runner ? best.score - runner.score : Number.POSITIVE_INFINITY;

  // 置信度：同名的往往是"市 vs 村/景点"，所以看的是**地名等级差**，不是总分差。
  //   天门  → 天门市(城市 30) vs 天门(村 8)      → 差 22 ⇒ high
  //   两个同名地级市互不相让                     → 差 0  ⇒ low（提示带上省份）
  const runnerRank = runner ? runner.rank : 0;
  const rankLead = best.rank - runnerRank;
  let confidence;
  if (best.rank >= 26 && (rankLead >= 10 || gap >= 40)) confidence = 'high';
  else if (best.rank >= 16 && (rankLead >= 4 || gap >= 25)) confidence = 'medium';
  else confidence = 'low';

  // 用户自己写了省名、而且赢家确实在这个省 ⇒ 他都说清楚了，别再提示"有歧义"。
  const winnerProvince = normalizeName(best.feature?.properties?.state ?? '');
  if (process.env.GEO_DBG) {
    console.error('DBG', JSON.stringify({
      provinceHint, winnerProvince, rank: best.rank, runnerRank, gap,
      osm: `${best.feature?.properties?.osm_key}/${best.feature?.properties?.osm_value}`,
      state: best.feature?.properties?.state,
      top: collected.slice(0, 4).map((c) => ({ n: c.feature.properties?.name, s: c.score, r: c.rank, st: c.feature.properties?.state })),
    }));
  }

  // 「省份对上了」不能只看 state —— 北京的朝阳区在 Photon 里 state 是空的，
  // 省名藏在 city/county 里。四个行政字段任何一个命中都算。
  const winnerFields = [
    best.feature?.properties?.state,
    best.feature?.properties?.city,
    best.feature?.properties?.county,
    best.feature?.properties?.district,
  ]
    .map(normalizeName)
    .filter(Boolean);
  if (provinceHint && best.rank >= 12) {
    const want = normalizeName(provinceHint);
    if (winnerFields.some((f) => f.includes(want))) confidence = 'high';
  }
  if (provinceHint && winnerProvince.includes(normalizeName(provinceHint)) && best.rank >= 12) {
    confidence = 'high';
  }

  return cacheSet(cacheKey, {
    ...featureToPlace(best.feature),
    geocoder: 'photon',
    confidence,
  });
}

async function fetchIpip() {
  const data = await fetchJson(IPIP_ENDPOINT);
  const location = data?.data?.location;
  if (!Array.isArray(location) || location.length === 0) return undefined;
  return {
    ip: data?.data?.ip,
    country: location[0],
    province: location[1],
    city: location[2],
    district: location[3],
    carrier: location[4],
  };
}

async function fetchIpwho() {
  const data = await fetchJson(IPWHO_ENDPOINT);
  if (!data || data.success === false) return undefined;
  return {
    ip: data.ip,
    country: data.country,
    countryCode: data.country_code,
    region: data.region,
    city: data.city,
    latitude: data.latitude,
    longitude: data.longitude,
    timezone: data.timezone?.id,
  };
}

function coordsPlace(ip, note) {
  if (!Number.isFinite(ip.latitude) || !Number.isFinite(ip.longitude)) return undefined;
  const display = [ip.region, ip.city].filter(Boolean).join('') || ip.city || ip.region || '本机位置';
  return {
    name: ip.city ?? '',
    admin1: ip.region ?? '',
    admin2: '',
    display,
    latitude: ip.latitude,
    longitude: ip.longitude,
    countryCode: String(ip.countryCode ?? '').toUpperCase(),
    note,
  };
}

async function detectIpLocation(signal) {
  const cached = cacheGet('ip-location');
  if (cached) return cached;

  const [ipipResult, ipwhoResult] = await Promise.allSettled([fetchIpip(), fetchIpwho()]);
  const ipip = ipipResult.status === 'fulfilled' ? ipipResult.value : undefined;
  const ipwho = ipwhoResult.status === 'fulfilled' ? ipwhoResult.value : undefined;

  const chinese = ipip?.country === '中国';
  if (!chinese && !(ipwho && isChinaCode(ipwho.countryCode))) {
    if (!ipip && !ipwho) {
      throw new Error('无法检测本机公网 IP 位置（定位服务暂不可用），请直接提供地区名，如“杭州”。');
    }
    const where = ipip?.country || ipwho?.country || '未知';
    throw new Error(`本机公网 IP 位于${where}，不在中国境内。本工具仅支持中国境内，请直接提供地区名，如“杭州”。`);
  }

  let place;
  if (chinese && ipip.city) {
    const query = /[市州盟县区旗]$/.test(ipip.city) ? ipip.city : `${ipip.city}市`;
    try {
      place = await geocode(query, {
        context: { province: ipip.province },
        signal,
      });
    } catch {
      place = undefined;
    }
  }

  if (!place && ipwho) {
    place = coordsPlace(ipwho, '按 IP 定位到城市级坐标，可能与实际位置有偏差');
    if (place && chinese) {
      place = {
        ...place,
        name: ipip.city || place.name,
        admin1: ipip.province || place.admin1,
        display: [ipip.province, ipip.city].filter(Boolean).join('') || place.display,
      };
    }
  }
  if (!place) {
    throw new Error('已检测到中国境内 IP，但无法解析具体城市，请直接提供地区名，如“杭州”。');
  }

  const value = {
    ...place,
    source: 'ip',
    ip: ipip?.ip || ipwho?.ip,
  };
  return cacheSet('ip-location', value);
}

async function fetchForecast(place, days, signal) {
  const key = `forecast:${place.latitude.toFixed(2)},${place.longitude.toFixed(2)}:${days}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = new URL(FORECAST_ENDPOINT);
  url.searchParams.set('latitude', String(place.latitude));
  url.searchParams.set('longitude', String(place.longitude));
  url.searchParams.set(
    'current',
    'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m',
  );
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max',
  );
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', String(days));

  const data = await fetchJson(url, { signal });
  if (!data?.current || !data?.daily) throw new Error('天气服务返回的数据不完整，请稍后重试。');
  return cacheSet(key, data);
}

async function fetchAirQuality(place, signal) {
  const key = `air:${place.latitude.toFixed(2)},${place.longitude.toFixed(2)}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const url = new URL(AIR_ENDPOINT);
  url.searchParams.set('latitude', String(place.latitude));
  url.searchParams.set('longitude', String(place.longitude));
  url.searchParams.set('current', 'pm2_5,pm10,us_aqi');
  url.searchParams.set('timezone', 'auto');

  try {
    const data = await fetchJson(url, { signal });
    const current = data?.current;
    if (!current || !Number.isFinite(current.us_aqi)) return cacheSet(key, null);
    return cacheSet(key, {
      aqi: Math.round(current.us_aqi),
      level: aqiLevel(current.us_aqi),
      pm25: round1(current.pm2_5),
      pm10: round1(current.pm10),
      time: current.time,
    });
  } catch {
    return cacheSet(key, null);
  }
}

function aqiLevel(aqi) {
  if (typeof aqi !== 'number' || !Number.isFinite(aqi)) return '未知';
  if (aqi <= 50) return '优';
  if (aqi <= 100) return '良';
  if (aqi <= 150) return '轻度污染';
  if (aqi <= 200) return '中度污染';
  if (aqi <= 300) return '重度污染';
  return '严重污染';
}

function buildValue({ input, place, forecast, air }) {
  const current = forecast.current;
  const daily = forecast.daily;

  const days = (daily.time ?? []).map((date, index) => ({
    date,
    weekday: weekdayOf(date),
    weather: weatherText(daily.weather_code?.[index]),
    weatherCode: daily.weather_code?.[index],
    high: round1(daily.temperature_2m_max?.[index]),
    low: round1(daily.temperature_2m_min?.[index]),
    rainProbability: daily.precipitation_probability_max?.[index],
    sunrise: timePart(daily.sunrise?.[index]),
    sunset: timePart(daily.sunset?.[index]),
    uvIndex: round1(daily.uv_index_max?.[index]),
  }));

  return {
    query: { input: input ?? '', resolvedBy: place.source === 'ip' ? 'ip' : 'name' },
    location: {
      display: place.display,
      name: place.name ?? '',
      admin1: place.admin1 ?? '',
      admin2: place.admin2 ?? '',
      latitude: place.latitude,
      longitude: place.longitude,
      timezone: forecast.timezone ?? '',
      source: place.source ?? 'name',
      geocoder: place.geocoder ?? '',
      confidence: place.confidence ?? 'high',
    },
    note: place.note,
    current: {
      time: current.time,
      weather: weatherText(current.weather_code),
      weatherCode: current.weather_code,
      temperature: round1(current.temperature_2m),
      apparentTemperature: round1(current.apparent_temperature),
      humidity: round1(current.relative_humidity_2m),
      precipitation: round1(current.precipitation),
      windSpeed: round1(current.wind_speed_10m),
      windDirection: windText(current.wind_direction_10m),
      isDay: current.is_day === 1,
    },
    daily: days,
    airQuality: air ?? undefined,
    sources: [
      'Open-Meteo（天气预报与空气质量，免费、无需密钥）',
      'Photon / OpenStreetMap（地名解析）',
      place.source === 'ip' ? 'ipip.net 与 ipwho.is（本机公网 IP 定位）' : '用户指定地区',
    ],
  };
}

function lineForDay(day, index) {
  const label = index === 0 ? '今天' : index === 1 ? '明天' : day.weekday ?? day.date;
  const temperature =
    typeof day.high === 'number' && typeof day.low === 'number'
      ? `${day.high}/${day.low}°C`
      : '气温未知';
  const pieces = [`${day.date} ${label}：${day.weather} ${temperature}`];
  if (typeof day.rainProbability === 'number') pieces.push(`降水概率 ${day.rainProbability}%`);
  if (day.sunrise && day.sunset) pieces.push(`日出 ${day.sunrise} / 日落 ${day.sunset}`);
  if (typeof day.uvIndex === 'number') pieces.push(`紫外线 ${day.uvIndex}`);
  return `- ${pieces.join('，')}`;
}

/** Render the value as the Chinese text summary the model reads. */
export function renderWeather(value) {
  const location = value.location ?? {};
  const current = value.current ?? {};
  const lines = [];

  lines.push(`📍 ${location.display || '未知地区'}${location.source === 'ip' ? '（本机 IP 自动定位）' : ''}`);
  if (location.confidence === 'low' && location.source !== 'ip') {
    lines.push('⚠️ 这个地名有同名地点，上面是按"城市>镇>村"的强弱挑的最优解。如果不对，用「省+市」再查一次（例：湖北省天门市）。');
  }
  lines.push(`🕘 ${String(current.time ?? '时间未知').replace('T', ' ')}（${location.timezone || '当地时间'}）`);
  if (value.note) lines.push(`ℹ️ ${value.note}`);

  const currentParts = [`${current.weather ?? '未知'} ${current.temperature ?? '-'}°C`];
  if (typeof current.apparentTemperature === 'number') currentParts.push(`体感 ${current.apparentTemperature}°C`);
  if (typeof current.humidity === 'number') currentParts.push(`湿度 ${current.humidity}%`);
  if (current.windDirection && typeof current.windSpeed === 'number') currentParts.push(`${current.windDirection} ${current.windSpeed} km/h`);
  if (typeof current.precipitation === 'number') currentParts.push(`降水 ${current.precipitation} mm`);
  lines.push(`🌡️ 当前：${currentParts.join('，')}`);

  if (value.airQuality) {
    const air = value.airQuality;
    const extra = [
      typeof air.pm25 === 'number' ? `PM2.5 ${air.pm25} μg/m³` : undefined,
      typeof air.pm10 === 'number' ? `PM10 ${air.pm10} μg/m³` : undefined,
    ].filter(Boolean);
    lines.push(`🍃 空气质量：AQI ${air.aqi}（${air.level}）${extra.length ? `，${extra.join('，')}` : ''}`);
  }

  const daily = Array.isArray(value.daily) ? value.daily : [];
  if (daily.length > 0) {
    lines.push('', `📅 未来 ${daily.length} 天：`);
    daily.forEach((day, index) => lines.push(lineForDay(day, index)));
  }

  const geocoderLabel = {
    amap: '高德',
    photon: 'Photon / OpenStreetMap',
    'open-meteo': 'Open-Meteo',
  }[location.geocoder] ?? 'Open-Meteo / Photon';
  lines.push('', `数据来源：天气 Open-Meteo，地名 ${geocoderLabel}（均免费）`);
  return lines.join('\n');
}

/** Drop undefined fields so the result stays lossless JSON. */
function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = compact(item);
    }
    return result;
  }
  return value;
}

/** Resolve a location and fetch current weather plus the daily forecast. */
export async function queryWeather({ location, days, signal } = {}) {
  const input = typeof location === 'string' ? location.trim() : '';
  if (input.length > 40) throw new Error('地区名过长，请提供城市或区县名称（如“杭州”“北京市朝阳区”）。');

  const requestedDays = Number.isFinite(days) ? Math.trunc(days) : 3;
  const forecastDays = Math.min(7, Math.max(1, requestedDays));

  const place = input ? await geocode(input, { signal }) : await detectIpLocation(signal);
  const [forecast, air] = await Promise.all([
    fetchForecast(place, forecastDays, signal),
    fetchAirQuality(place, signal),
  ]);

  return JSON.parse(JSON.stringify(compact(buildValue({ input, place, forecast, air }))));
}
