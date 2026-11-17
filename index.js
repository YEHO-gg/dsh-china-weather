import { queryWeather, renderWeather } from './weather.js';

/** Cordis plugin name. */
export const name = 'weather-cn';

/** Register the weather tool on the global tool registry. */
export const inject = ['tools'];

const parameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    location: {
      type: 'string',
      description:
        '中国境内地区名。**强烈建议写「省+市/县」全称**，如“湖北省天门市”“浙江省杭州市”“北京市朝阳区”。' +
        '只写裸地名（如“天门”“朝阳”）会有同名地点，工具只能按「城市>镇>村」的强弱猜一个，可能猜错；' +
        '结果里的 location.confidence 为 low 时表示它就是猜的。省略则自动按本机公网 IP 定位。不接受中国境外地区。',
    },
    days: {
      type: 'integer',
      description: '预报天数，1-7，默认 3。',
      default: 3,
    },
  },
};

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string' },
        resolvedBy: { type: 'string' },
      },
    },
    weatherSource: {
      type: 'string',
      description: '这次预报用的是哪个数据源：china-weather（中国天气网）/ open-meteo / wttr。超时后会自动换下一个。',
    },
    location: {
      type: 'object',
      additionalProperties: false,
      properties: {
        display: { type: 'string' },
        name: { type: 'string' },
        admin1: { type: 'string' },
        admin2: { type: 'string' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        timezone: { type: 'string' },
        source: { type: 'string' },
        geocoder: {
          type: 'string',
          description: '这次地名解析用的是哪个来源：amap（高德，需 AMAP_KEY）/ photon / open-meteo',
        },
        confidence: {
          type: 'string',
          description: '地名有多确定：high / medium / low。low 表示同名歧义，结果可能是猜的。',
        },
      },
      required: ['display', 'latitude', 'longitude'],
    },
    note: { type: 'string' },
    current: {
      type: 'object',
      additionalProperties: false,
      properties: {
        time: { type: 'string' },
        weather: { type: 'string' },
        weatherCode: { type: 'integer' },
        temperature: { type: 'number' },
        apparentTemperature: { type: 'number' },
        humidity: { type: 'number' },
        precipitation: { type: 'number' },
        windSpeed: { type: 'number' },
        windDirection: { type: 'string' },
        isDay: { type: 'boolean' },
      },
      required: ['time', 'weather'],
    },
    daily: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string' },
          weekday: { type: 'string' },
          weather: { type: 'string' },
          weatherCode: { type: 'integer' },
          high: { type: 'number' },
          low: { type: 'number' },
          rainProbability: { type: 'number' },
          sunrise: { type: 'string' },
          sunset: { type: 'string' },
          uvIndex: { type: 'number' },
        },
        required: ['date', 'weather'],
      },
    },
    airQuality: {
      type: 'object',
      additionalProperties: false,
      properties: {
        aqi: { type: 'number' },
        level: { type: 'string' },
        pm25: { type: 'number' },
        pm10: { type: 'number' },
        time: { type: 'string' },
      },
    },
    sources: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['location', 'current', 'daily'],
};

const tool = {
  name: 'weather',
  description:
    '查询中国境内（含港澳台）的实时天气与未来 1-7 天预报。省略 location 时自动按本机公网 IP 定位；也可指定地区——**请优先传「省+市/县」全称（如“湖北省天门市”）**，裸地名有同名歧义。返回实况（气温、体感、湿度、降水、风力）、日出日落、紫外线、逐日预报和空气质量，以及 location.geocoder（这次用的是哪个地理库）和 location.confidence（地名有多确定）。预报有多个数据源轮换：中国天气网（中央气象台体系，国内直连）→ Open-Meteo → wttr.in，一个超时就换下一个，返回里的 weatherSource 会写明这次用的是哪家；地名解析用 Photon/OSM。全部免费、无需 API 密钥。中国境外地区会返回错误。当用户询问天气、气温、下雨、穿衣或出行建议时优先调用。',
  parameters,
  output: {
    schema: outputSchema,
    render: (_args, value) => [{ type: 'text', text: renderWeather(value) }],
  },
  timeoutMs: 40_000,
  isConcurrencySafe: () => true,
  async execute(args) {
    return queryWeather({
      location: args?.location,
      days: args?.days,
    });
  },
  presentCall(args) {
    return {
      card: 'generic',
      title: args?.location ? `查询天气 · ${args.location}` : '查询天气 · 自动定位',
      rawInput: args,
    };
  },
};

/**
 * Register the weather tool for model and PTC callers.
 * @param ctx - Cordis context carrying the tool registry.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(tool), 'weather tool');
}
