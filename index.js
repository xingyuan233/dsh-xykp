// dsh-xykp 的「门面」插件：本身不干业务。
//
// 为什么要有它：DSH 的客户端加载器只认「整包名」的 Loader 行
// （exactPackageSpecifier 不认 'dsh-xykp/chat/xxx' 这种子路径），
// 所以仓库里那些子路径插件不会触发浏览器端 bundle。
// 这里挂一个空插件把包名挂上去，客户端产物（./client）才会被扫到。
export const name = 'xykp'

export function apply() {}
