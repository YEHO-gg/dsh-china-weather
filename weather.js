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
 * 备用数据源（2026-11-17 加）。
 *
 * 起因：`api.open-meteo.com` 从国内只有一个 A 记录（51.81.167.44，OVH，RTT ~350ms），
 * 实测 5 次里 2 次成功——TCP 443 会随机超时。插件原来没有重试，一次握手失败就直接
 * 把 `fetch failed` 抛给模型，看起来像插件坏了，其实是单点线路抽风。
 *
 * 改法：预报改成"数据源轮换"，一个超时就换下一个，谁先答应用谁。
 *   1. Open-Meteo    —— 有体感温度、紫外线、逐时，字段最全
 *   2. 中国天气网     —— 中央气象台体系，国内直连，和手机天气 App 口径一致
 *   3. wttr.in       —— 第三套基础设施，前面全挂时兜底
 */
const CN_SEARCH_ENDPOINT = 'http://toy1.weather.com.cn/search';
const CN_SK_ENDPOINT = 'http://d1.weather.com.cn/sk_2d';
const CN_PAGE_ENDPOINT = 'http://www.weather.com.cn/weather';
const WTTR_ENDPOINT = 'https://wttr.in';

const CN_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  referer: 'http://www.weather.com.cn/',
  accept: 'application/json, text/html, */*',
};

/** 单次尝试的最长等待：超过就认定这条线路不通，换下一个源 */
const PROVIDER_ATTEMPT_MS = 10_000;
/** 刚失败的源，冷却期间直接跳过，省得每次都白等 7 秒 */
const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;
const providerCooldown = new Map();

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

/** 失败重试一次：Photon 实测三次里只成一次，一次就放弃太亏。 */
async function fetchJsonWithRetry(url, { attempts = 2, ...options } = {}) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) break;
    }
  }
  throw lastError ?? new Error('请求失败');
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
    // 省偏置只给"居民点"。否则「沙湖」这种湖泊会靠着 IP 在湖北 +20 分，
    // 反过来压过外省真正的镇 —— 那是在回答一个没人问的湖。
    if (rank > 0 && province && fields.some((field) => field.includes(province))) score += 20;
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

/**
 * 「本机 IP 在哪个省」——用户没写省名时的兜底线索。
 *
 * 为什么需要：`天门`「朝阳」「建设」这种裸地名，全国有几十个同名的镇/村。
 * 光靠「城市>镇>村」只能挑"最大的那个"，跟你实际在哪儿无关。
 * 加一层 IP 省偏置之后，同名打平时会优先留在你所在的省。
 *
 * 只作为 +20 的加权，不会翻转"名字完全匹配"的候选（那有 100 分），
 * 所以人在湖北问「北京朝阳区」不会被打成湖北。
 *
 * 拿不到就返回空串——绝不因为 IP 服务挂了就查不了天气。
 */
async function ipProvince(signal) {
  const cached = cacheGet('ip:province');
  if (cached !== undefined) return cached.value;

  let value = '';
  try {
    const place = await detectIpLocation(signal);
    value = detectProvince(place?.admin1 ?? place?.display ?? '');
  } catch {
    value = '';
  }
  cacheSet('ip:province', { value });
  return value;
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
  let effectiveContext = context ?? (provinceHint ? { province: provinceHint } : undefined);

  // ★ 没写省名就并行问一下本机 IP 在哪个省。
  //   注意别 await ——快路径命中时根本用不到它，await 会白白多等 1 秒。
  //   也不能在 detectIpLocation 里递归时触发：那条路径一定会带 context（见函数内）。
  const ipProvincePromise = effectiveContext
    ? Promise.resolve('')
    : ipProvince(signal).catch(() => '');

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

  // 走到 Photon 这一层才真正需要 IP 省：快路径已经排除了"人口为 0 / 没命中"的情况。
  if (!effectiveContext) {
    const ipProv = await ipProvincePromise;
    if (ipProv) effectiveContext = { province: ipProv };
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

      const data = await fetchJsonWithRetry(url, { signal, timeoutMs: PHOTON_TIMEOUT_MS });
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
  const strong = rankLead >= 10 || gap >= 40;   // 要么等级压制，要么总分甩开
  const decent = rankLead >= 4 || gap >= 20;
  let confidence;
  if (best.rank >= 26 && strong) confidence = 'high';
  else if (best.rank >= 16 && strong) confidence = 'high';
  else if (best.rank >= 8 && decent) confidence = 'medium';
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

async function openMeteoForecast(place, days, signal) {
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

  const data = await fetchJson(url, { signal, timeoutMs: PROVIDER_ATTEMPT_MS });
  if (!data?.current || !data?.daily) throw new Error('返回的数据不完整');
  return { ...data, provider: 'open-meteo', providerLabel: 'Open-Meteo' };
}

/* ───────────────────────── 备用数据源 ───────────────────────── */

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const parsed = Number.parseFloat(String(value ?? '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function fetchRaw(url, { signal, timeoutMs = REQUEST_TIMEOUT_MS, headers = CN_HEADERS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('上游请求超时')), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await withTimeout(
      fetch(url, { headers, signal: combined }),
      timeoutMs,
      '上游请求超时',
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取文本并按内容猜编码。
 *
 * 中国天气网两个接口编码不一样：网页是 UTF-8，d1 的接口有的还是 GBK。
 * 先按严格 UTF-8 解，解不动再退回 GBK——GBK 几乎什么字节都能"解成功"，
 * 所以不能拿它当第一选择，否则 UTF-8 的中文会被解成乱码。
 */
async function fetchText(url, { charset = 'auto', ...options } = {}) {
  const response = await fetchRaw(url, options);
  const buffer = await response.arrayBuffer();
  const labels = charset === 'auto' ? ['utf-8', 'gbk', 'gb2312'] : [charset, 'utf-8', 'gbk'];
  for (const label of labels) {
    try {
      return new TextDecoder(label, { fatal: label.startsWith('utf-8') }).decode(buffer);
    } catch {
      // 换下一个编码
    }
  }
  return new TextDecoder('utf-8').decode(buffer);
}

/** 北京时间的"今天 + offset 天"，返回 YYYY-MM-DD。 */
function cnDateFor(offset) {
  const beijing = new Date(Date.now() + 8 * 3600_000);
  const target = new Date(
    Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate() + offset),
  );
  return target.toISOString().slice(0, 10);
}

/**
 * 地名 → 中国天气网城市码（如 天门 → 101201501）。
 * 走 toy1.weather.com.cn/search，必须带 Referer，否则返回空。
 */
async function chinaWeatherCode(place, signal) {
  const key = `cn:code:${normalizeName(place?.name) || normalizeName(place?.display) || ''}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const province = detectProvince(`${place?.admin1 ?? ''}${place?.display ?? ''}`);
  const names = [];
  for (const raw of [place?.name, place?.admin2, place?.display]) {
    const name = normalizeName(raw);
    if (name && !names.includes(name)) names.push(name);
  }

  for (const name of names) {
    let text = '';
    for (let attempt = 0; attempt < 2 && !text; attempt += 1) {
      try {
        text = await fetchText(`${CN_SEARCH_ENDPOINT}?cityname=${encodeURIComponent(name)}`, {
          signal,
          timeoutMs: 6_000,
        });
      } catch {
        // 这个源偶尔会空手而归，重试一次再说
      }
    }
    if (!text) continue;
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) continue;
    let list;
    try {
      list = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    let best;
    for (const entry of Array.isArray(list) ? list : []) {
      // ref 形如 101201501~hubei~天门~Tianmen~天门~Tianmen~728~431700~TM~湖北
      // 景点码带字母后缀（10122030102A），天气接口不认，直接排除。
      const parts = String(entry?.ref ?? '').split('~');
      const code = parts[0];
      if (!/^\d{9,12}$/.test(code)) continue;
      const nameCn = (parts[2] ?? '').trim();
      const provinceCn = (parts[9] ?? '').trim();
      let score = 0;
      if (nameCn === name) score += 60;
      else if (nameCn.startsWith(name)) score += 30;
      else continue;
      if (province && provinceCn && (provinceCn.includes(province) || province.includes(provinceCn))) {
        score += 40;
      }
      if (!best || score > best.score) best = { code, score };
    }
    if (best) return cacheSet(key, best.code);
  }
  throw new Error('中国天气网没有收录这个地名');
}

/** 解析 7 天页面的 <li> 列表：天气文字 + 最高/最低温。 */
function parseCnDaily(html, days) {
  const anchor = html.indexOf('class="t clearfix"');
  const scope = anchor >= 0 ? html.slice(anchor) : html;
  const rows = [];
  const re = /<li[^>]*class="sky[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let match;
  while ((match = re.exec(scope)) && rows.length < days) {
    const block = match[1];
    const wea = (block.match(/class="wea"[^>]*>([^<]+)</) ?? [])[1];
    if (!wea) continue;
    const temBlock = (block.match(/class="tem"[^>]*>([\s\S]*?)<\/p>/) ?? [])[1] ?? '';
    rows.push({
      weather: wea.trim(),
      high: num((temBlock.match(/<span>\s*(-?\d+)\s*℃/) ?? [])[1]),
      low: num((temBlock.match(/<i>\s*(-?\d+)\s*℃/) ?? [])[1]),
    });
  }
  return rows;
}

function parseCnSk(text) {
  if (!text) return {};
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
}

async function chinaWeatherForecast(place, days, signal) {
  const code = await chinaWeatherCode(place, signal);
  const [page, skText] = await Promise.all([
    fetchText(`${CN_PAGE_ENDPOINT}/${code}.shtml`, {
      signal,
      timeoutMs: PROVIDER_ATTEMPT_MS,
    }),
    fetchText(`${CN_SK_ENDPOINT}/${code}.html`, {
      signal,
      timeoutMs: PROVIDER_ATTEMPT_MS,
    }).catch(() => ''),
  ]);

  const rows = parseCnDaily(page, days);
  if (!rows.length) throw new Error('页面里没解析出预报');

  const sk = parseCnSk(skText);
  const clock = /^\d{1,2}:\d{2}$/.test(String(sk?.time ?? '')) ? String(sk.time) : '00:00';
  const hour = Number(clock.split(':')[0]);

  const current = {
    time: `${cnDateFor(0)}T${clock.padStart(5, '0')}`,
    weather_text: typeof sk?.weather === 'string' ? sk.weather.trim() : undefined,
    temperature_2m: num(sk?.temp),
    relative_humidity_2m: num(String(sk?.SD ?? sk?.sd ?? '').replace('%', '')),
    precipitation: num(sk?.rain),
    wind_speed_10m: num(sk?.wse),
    wind_text: typeof sk?.WD === 'string' ? sk.WD.trim() : undefined,
    is_day: hour >= 6 && hour < 18 ? 1 : 0,
  };

  const base = {
    current,
    daily: {
      time: rows.map((_, index) => cnDateFor(index)),
      weather_text: rows.map((row) => row.weather),
      weather_code: rows.map(() => undefined),
      temperature_2m_max: rows.map((row) => row.high),
      temperature_2m_min: rows.map((row) => row.low),
    },
    timezone: 'Asia/Shanghai',
    provider: 'china-weather',
    providerLabel: `中国天气网（中央气象台体系，城市码 ${code}）`,
  };

  // 中国天气网没有体感/紫外线/日出日落。Open-Meteo 顺手能拿到就补上，
  // 拿不到（大概率是线路又抽风）也绝不拖慢主流程——最多等 3.5 秒。
  const enrich = await withTimeout(
    openMeteoForecast(place, days, signal),
    3_500,
    '补数据超时',
  ).catch(() => undefined);
  return enrich ? mergeEnrichment(base, enrich) : base;
}

/** 用 Open-Meteo 补齐中国天气网缺的字段，冲突时以中国天气网为准。 */
function mergeEnrichment(base, extra) {
  const current = { ...base.current };
  const daily = { ...base.daily };
  const fill = (target, source, key) => {
    if (source?.[key] !== undefined) target[key] = source[key];
  };

  if (current.apparent_temperature === undefined) {
    fill(current, extra?.current, 'apparent_temperature');
  }
  if (current.is_day === undefined) fill(current, extra?.current, 'is_day');
  if (current.wind_direction_10m === undefined) {
    fill(current, extra?.current, 'wind_direction_10m');
  }

  for (const key of [
    'precipitation_probability_max',
    'sunrise',
    'sunset',
    'uv_index_max',
    'weather_code',
  ]) {
    if (daily[key] === undefined) fill(daily, extra?.daily, key);
  }

  // 今天的白天已经过完了，中国天气网就不给今天的高温了（只留低温）。
  // 逐位补：只补空洞，不覆盖已有的数字。
  for (const key of ['temperature_2m_max', 'temperature_2m_min']) {
    const target = daily[key];
    const source = extra?.daily?.[key];
    if (!Array.isArray(target) || !Array.isArray(source)) continue;
    daily[key] = target.map((value, index) =>
      value === undefined && source[index] !== undefined ? source[index] : value,
    );
  }

  return {
    ...base,
    current,
    daily,
    providerLabel: `${base.providerLabel} + Open-Meteo 补充体感/紫外线`,
  };
}

/** wttr.in 只给英文天气描述，转一道；没收录的原样返回。 */
const WTTR_TEXT = new Map([
  ['sunny', '晴'], ['clear', '晴'], ['partly cloudy', '晴间多云'], ['cloudy', '多云'],
  ['overcast', '阴'], ['mist', '薄雾'], ['fog', '雾'], ['freezing fog', '冻雾'],
  ['haze', '霾'], ['smoky haze', '烟霾'], ['smoke', '烟霾'],
  ['patchy rain nearby', '局部有雨'], ['patchy rain possible', '可能有雨'],
  ['light drizzle', '毛毛雨'], ['patchy light drizzle', '零星毛毛雨'],
  ['light rain', '小雨'], ['moderate rain', '中雨'], ['heavy rain', '大雨'],
  ['light rain shower', '阵雨'], ['moderate or heavy rain shower', '中到大阵雨'],
  ['patchy light rain', '零星小雨'], ['torrential rain shower', '暴雨'],
  ['thundery outbreaks possible', '可能有雷阵雨'], ['patchy light rain with thunder', '雷阵雨'],
  ['moderate or heavy rain with thunder', '强雷雨'],
  ['light snow', '小雪'], ['moderate snow', '中雪'], ['heavy snow', '大雪'],
  ['patchy snow possible', '可能有雪'], ['patchy light snow', '零星小雪'],
  ['light snow showers', '阵雪'], ['blizzard', '暴风雪'], ['sleet', '雨夹雪'],
  ['light sleet', '小雨夹雪'], ['moderate or heavy sleet', '中到大雨夹雪'],
]);

function wttrText(value) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return WTTR_TEXT.get(cleaned.toLowerCase()) ?? cleaned;
}

/** "02:48 PM" / "6:55" / "14:03" → "14:48" / "06:55" / "14:03" */
function clock24(value) {
  const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = match[2];
  const suffix = (match[3] ?? '').toUpperCase();
  if (suffix === 'PM' && hour < 12) hour += 12;
  if (suffix === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

/** "14:48" + 8 小时 → "22:48"（跨零点按 24 小时回绕）。 */
function shiftClock(clock, hours) {
  if (!clock) return undefined;
  const [rawHour, minute] = clock.split(':').map(Number);
  const hour = (((rawHour + hours) % 24) + 24) % 24;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

async function wttrForecast(place, days, signal) {
  const url = `${WTTR_ENDPOINT}/${place.latitude.toFixed(3)},${place.longitude.toFixed(3)}?format=j1&lang=zh`;
  const data = await fetchJson(url, { signal, timeoutMs: PROVIDER_ATTEMPT_MS });

  const current = data?.current_condition?.[0];
  const list = Array.isArray(data?.weather) ? data.weather.slice(0, days) : [];
  if (!current || !list.length) throw new Error('返回的数据不完整');

  const descOf = (item) =>
    wttrText(item?.weatherDesc?.[0]?.value) ?? wttrText(item?.lang_zh?.[0]?.value);

  const rainOf = (day) => {
    const chances = (day?.hourly ?? [])
      .map((hour) => num(hour?.chanceofrain))
      .filter((value) => typeof value === 'number');
    return chances.length ? Math.max(...chances) : undefined;
  };

  return {
    current: {
      // wttr 的 observation_time 是 UTC，转成北京时间再显示。
      time: `${cnDateFor(0)}T${shiftClock(clock24(current.observation_time), 8) ?? clock24(new Date().toISOString().slice(11, 16))}`,
      weather_text: descOf(current),
      temperature_2m: num(current.temp_C),
      apparent_temperature: num(current.FeelsLikeC),
      relative_humidity_2m: num(current.humidity),
      precipitation: num(current.precipMM),
      wind_speed_10m: num(current.windspeedKmph),
      wind_direction_10m: num(current.winddirDegree),
      is_day: undefined,
    },
    daily: {
      time: list.map((day) => day.date),
      weather_text: list.map((day) => descOf(day?.hourly?.[4]) ?? descOf(day?.hourly?.[0])),
      weather_code: list.map(() => undefined),
      temperature_2m_max: list.map((day) => num(day.maxtempC)),
      temperature_2m_min: list.map((day) => num(day.mintempC)),
      precipitation_probability_max: list.map(rainOf),
      sunrise: list.map((day) => clock24(day?.astronomy?.[0]?.sunrise)),
      sunset: list.map((day) => clock24(day?.astronomy?.[0]?.sunset)),
      uv_index_max: list.map((day) => num(day?.hourly?.[4]?.uvIndex)),
    },
    timezone: 'Asia/Shanghai',
    provider: 'wttr',
    providerLabel: 'wttr.in（World Weather Online 数据）',
  };
}

// 顺序有讲究：中国天气网是唯一从国内稳定连得上的源（实测 0.1~1s），
// 而且它的口径和手机天气 App 一致；Open-Meteo 有体感/紫外线但线路抽风，
// 排在第二当补充/兜底；wttr.in 的线路也不稳，最后。
const FORECAST_PROVIDERS = [
  { name: 'china-weather', run: chinaWeatherForecast },
  { name: 'open-meteo', run: openMeteoForecast },
  { name: 'wttr', run: wttrForecast },
];

/** 预报主入口：按顺序试数据源，一个超时/失败就换下一个，谁先答应用谁。 */
async function fetchForecast(place, days, signal) {
  const key = `forecast:${place.latitude.toFixed(2)},${place.longitude.toFixed(2)}:${days}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const failures = [];
  for (const provider of FORECAST_PROVIDERS) {
    if ((providerCooldown.get(provider.name) ?? 0) > Date.now()) {
      failures.push(`${provider.name}（冷却中）`);
      continue;
    }
    try {
      const data = await provider.run(place, days, signal);
      providerCooldown.delete(provider.name);
      return cacheSet(key, data);
    } catch (error) {
      // 「没收录这个地名」是这个地名的问题，不是这条线路挂了——
      // 别让它把整个源冷却掉，否则查一次小地方，后面 5 分钟全都用不上它。
      const dataMissing = /没有收录/.test(error?.message ?? '');
      if (!dataMissing) {
        providerCooldown.set(provider.name, Date.now() + PROVIDER_COOLDOWN_MS);
      }
      const reason = error?.name === 'AbortError' ? '超时' : (error?.message ?? '未知错误');
      failures.push(`${provider.name}（${reason}）`);
      if (signal?.aborted) break;
    }
  }
  throw new Error(`所有天气数据源都失败了：${failures.join('、')}。请稍后重试。`);
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
  const providerLabel = forecast.providerLabel ?? 'Open-Meteo';

  // 备用源直接给中文天气文字（"多云转晴"这种没法反查 WMO 码），所以优先用文字。
  const dayText = (index) =>
    daily.weather_text?.[index] ?? weatherText(daily.weather_code?.[index]);

  const days = (daily.time ?? []).map((date, index) => ({
    date,
    weekday: weekdayOf(date),
    weather: dayText(index),
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
    weatherSource: forecast.provider ?? 'open-meteo',
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
      weather: current.weather_text ?? weatherText(current.weather_code),
      weatherCode: current.weather_code,
      temperature: round1(current.temperature_2m),
      apparentTemperature: round1(current.apparent_temperature),
      humidity: round1(current.relative_humidity_2m),
      precipitation: round1(current.precipitation),
      windSpeed: round1(current.wind_speed_10m),
      windDirection: current.wind_text ?? windText(current.wind_direction_10m),
      isDay: current.is_day === 1,
    },
    daily: days,
    airQuality: air ?? undefined,
    sources: [
      `${providerLabel}（天气预报，免费、无需密钥）`,
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
      : typeof day.high === 'number'
        ? `最高 ${day.high}°C`
        : typeof day.low === 'number'
          ? `最低 ${day.low}°C`
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
  const providerLabel = value.sources?.[0]?.replace(/（天气预报.*$/, '') ?? 'Open-Meteo';
  lines.push('', `数据来源：天气 ${providerLabel}，地名 ${geocoderLabel}（均免费）`);
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
