// 特殊 id 解析单测：0 = 上一步全部；-1 = 最近一条，-2 = 倒数第二……
import assert from 'node:assert/strict'

import { resolveIds } from '../lib/index.js'

let n = 0
const eq = (name, got, want) => {
  assert.deepEqual(got, want, name)
  n++
  console.log('ok:', name)
}

eq('0 = step ids', resolveIds([0], [5, 6], [9, 8]), [5, 6])
eq('positive passthrough', resolveIds([7], [5], [9]), [7])
eq('-1 = newest', resolveIds([-1], [], [9, 8, 5]), [9])
eq('-3 = third newest', resolveIds([-3], [], [9, 8, 5]), [5])
eq('out of range keeps raw', resolveIds([-7], [], [9, 8]), [-7])
eq('mixed', resolveIds([0, -1, 4], [5, 6], [9, 8]), [5, 6, 9, 4])
eq('empty', resolveIds([], [5], []), [])

console.log(`refs ok (${n} cases)`)
