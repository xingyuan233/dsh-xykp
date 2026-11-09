// 分流规则单测（不碰 IO、不碰宿主）
import assert from 'node:assert/strict'
import { chatKeyOf, normalizeKey, parseTargetRef, resolveRoute, formatIncoming } from '../lib/router.js'

const base = {
  defaultTarget: 'p-alive',
  mode: 'blacklist',
  blocked: [],
  allowed: [],
  mappings: [],
}

let n = 0
function t(name, fn) {
  n++
  try { fn(); console.log('  ok  ' + name) } catch (err) { console.error('  FAIL ' + name + ': ' + err.message); process.exitCode = 1 }
}

console.log('router:')

t('chatKeyOf 私聊', () => assert.equal(chatKeyOf({ chatType: 1, peerUid: 'u_abc' }), 'u-u_abc'))
t('chatKeyOf 群聊', () => assert.equal(chatKeyOf({ chatType: 2, peerUid: '123456' }), 'g-123456'))
t('chatKeyOf 空', () => assert.equal(chatKeyOf({}), ''))

t('normalizeKey 大小写/分隔符', () => {
  assert.equal(normalizeKey('U-u_abc'), 'u-u_abc')
  assert.equal(normalizeKey('g-123'), 'g-123')
  assert.equal(normalizeKey('123'), 'u-123')
})

t('parseTargetRef 预设', () => assert.deepEqual(parseTargetRef('p-alive'), { kind: 'preset', value: 'alive' }))
t('parseTargetRef 会话', () => assert.deepEqual(parseTargetRef('s-abc123'), { kind: 'session', value: 'abc123' }))
t('parseTargetRef 裸写按会话', () => assert.deepEqual(parseTargetRef('abc123'), { kind: 'session', value: 'abc123' }))

t('黑名单默认放行', () => {
  const r = resolveRoute(base, 'u-u_abc')
  assert.equal(r.target, 'p-alive')
  assert.equal(r.via, 'default')
})

t('黑名单挡住', () => {
  const r = resolveRoute({ ...base, blocked: ['u-u_abc'] }, 'u-u_abc')
  assert.equal(r.target, '')
  assert.equal(r.reason, '在黑名单')
})

t('白名单只放名单里的', () => {
  const cfg = { ...base, mode: 'whitelist', allowed: ['g-123'] }
  assert.equal(resolveRoute(cfg, 'g-123').target, 'p-alive')
  assert.equal(resolveRoute(cfg, 'u-u_abc').target, '')
})

t('映射优先于名单', () => {
  const cfg = { ...base, blocked: ['u-u_abc'], mappings: [{ chat: 'u-u_abc', target: 's-deadbeef' }] }
  const r = resolveRoute(cfg, 'u-u_abc')
  assert.equal(r.target, 's-deadbeef')
  assert.equal(r.via, 'mapping')
})

t('映射也支持群', () => {
  const cfg = { ...base, mappings: [{ chat: 'g-999', target: 'p-work' }] }
  assert.equal(resolveRoute(cfg, 'g-999').target, 'p-work')
})

t('没配默认目标时不动', () => {
  const r = resolveRoute({ ...base, defaultTarget: '' }, 'u-u_abc')
  assert.equal(r.target, '')
})

t('formatIncoming 私聊文本', () => {
  const text = formatIncoming({
    chatType: 1, peerUid: 'u_u1', senderUid: 'u_u1', senderName: '星鸢',
    time: new Date('2026-10-27T21:30:00').getTime(),
    elements: [{ type: 1, text: '在吗' }],
  })
  assert.match(text, /^\[QQ私聊 u-u_u1\] 21:30 星鸢\n在吗$/)
})

t('formatIncoming 群聊带图片', () => {
  const text = formatIncoming({
    chatType: 2, peerUid: '123456', senderUid: 'u_u1', senderName: '某人',
    time: new Date('2026-10-27T08:05:00').getTime(),
    elements: [{ type: 1, text: '看这个' }, { type: 2, pic: { fileName: 'a.jpg', sourcePath: 'C:\\x\\a.jpg' } }],
  })
  assert.match(text, /^\[QQ群 g-123456\] 08:05 某人\n看这个\[图片 a\.jpg → C:\\x\\a\.jpg\]$/)
})

console.log(`\n${n} 条路由用例完成${process.exitCode ? '（有失败）' : '，全过'}`)
