export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
export const DAY = 86400000

/** 按 keyOf 降序插入，返回插入位置 */
export function insertSorted(arr, item, keyOf) {
  const k = keyOf(item)
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (keyOf(arr[mid]) >= k) lo = mid + 1
    else hi = mid
  }
  arr.splice(lo, 0, item)
  return lo
}

/** w 变大之后往前冒泡，通常 0~2 步 */
export function bubbleUp(arr, index, keyOf) {
  while (index > 0 && keyOf(arr[index - 1]) < keyOf(arr[index])) {
    const t = arr[index - 1]
    arr[index - 1] = arr[index]
    arr[index] = t
    index--
  }
  return index
}
