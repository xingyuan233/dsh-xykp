// 本地评测：不经过 dsh web，直接跑引擎 + 重排 + 富化，对比结果质量与耗时。
// 用法：node bench.mjs "query1" "query2"
import { searchEngine, engineIds } from './engines.js'
import { enhanceResults } from './ranking.js'

const cfg = {
  engines: process.env.ENGINES ? process.env.ENGINES.split(',') : ['google', 'baidu', 'bing'],
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  timeoutMs: 25000,
  enrichLimit: 6,
}

const queries = process.argv.slice(2)
if (!queries.length) queries.push('DeepSeek V4.1 Flash 发布')

for (const query of queries) {
  console.log(`\n=== ${query} ===`)
  const t0 = Date.now()
  const settled = await Promise.allSettled(cfg.engines.map((id) => searchEngine(id, query, cfg)))
  const buckets = settled.map((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`[engine] ${cfg.engines[i]}: ${r.value.length} 条 (${Date.now() - t0}ms)`)
      return r.value
    }
    console.log(`[engine] ${cfg.engines[i]}: 失败 ${r.reason?.message ?? r.reason}`)
    return []
  })
  const tSearch = Date.now() - t0

  const result = await enhanceResults({ buckets, query, limit: 8, config: cfg })
  console.log(
    `[timing] search=${tSearch}ms total=${Date.now() - t0}ms sources=${result.sources.length} truncated=${result.truncated}`,
  )
  result.sources.forEach((s, i) => {
    console.log(`${i + 1}. ${s.title}\n   ${s.url}\n   ${s.publishedAt ?? '-'} | ${(s.snippet || '').slice(0, 180)}`)
  })
}

void engineIds
