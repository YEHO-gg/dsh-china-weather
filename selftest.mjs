import { queryWeather, renderWeather } from './weather.js';

const cases = [
  { label: '自动 IP 定位', args: {} },
  { label: '城市：杭州', args: { location: '杭州' } },
  { label: '区县：北京市朝阳区', args: { location: '北京市朝阳区' } },
  { label: '省+市：湖北省天门市', args: { location: '湖北省天门市', days: 1 } },
  { label: '边疆：乌鲁木齐', args: { location: '乌鲁木齐', days: 5 } },
  { label: '境外：纽约', args: { location: '纽约' } },
  { label: '境外：New York', args: { location: 'New York' } },
  { label: '区县单查：西湖区', args: { location: '西湖区' } },
  { label: '新区：上海市浦东新区', args: { location: '上海市浦东新区', days: 2 } },
  { label: '香港', args: { location: '香港', days: 2 } },
  { label: '缓存复用：杭州', args: { location: '杭州' } },
];

let failed = 0;
for (const item of cases) {
  const started = Date.now();
  try {
    const value = await queryWeather(item.args);
    console.log(`\n=== ${item.label} (${Date.now() - started}ms) ===`);
    console.log(renderWeather(value));
  } catch (error) {
    failed += 1;
    console.log(`\n=== ${item.label} (${Date.now() - started}ms) ===`);
    console.log(`ERROR: ${error.message}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} succeeded`);
