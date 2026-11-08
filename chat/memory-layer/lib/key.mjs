/**
 * 关键词归一 —— 只做「形式归一」，不做同义词展开。
 * 同义/指代的归一是写入时由模型自己给最简词的，这里不管。
 */

export function normalizeKey(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_·]+/g, ' ')
    .trim()
}

/**
 * 一个 key 拆成匹配用的 gram：
 *   单字 → 它本身
 *   多字 → 全部 bigram（去重）
 * 这样「草莓」只需要输入里出现「草莓」两个连续字，而「那盒草莓」也能中。
 */
export function gramsOf(key) {
  const k = normalizeKey(key).replace(/ /g, '')
  if (!k) return []
  if (k.length === 1) return [k]
  const set = new Set()
  for (let i = 0; i < k.length - 1; i++) set.add(k.slice(i, i + 2))
  return [...set]
}

/**
 * 输入文本拆成 gram 集合：单字 + bigram。
 * 单字是为了让单字概念（鱼 / 猫）也能命中。
 */
export function queryGrams(text) {
  const s = normalizeKey(text)
  const set = new Set()
  for (const ch of s) {
    if (ch === ' ') continue
    set.add(ch)
  }
  const dense = s.replace(/ /g, '')
  for (let i = 0; i < dense.length - 1; i++) set.add(dense.slice(i, i + 2))
  return set
}
