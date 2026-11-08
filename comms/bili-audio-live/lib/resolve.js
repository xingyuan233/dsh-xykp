/**
 * bili-audio-live :: dependency resolver
 * The plugin installs into a profile whose node_modules does not hoist
 * sherpa-onnx-node / ws, so look them up next to the host binary as well.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

function* roots() {
  if (process.env.DSH_NPM_ROOT) yield process.env.DSH_NPM_ROOT;
  if (process.env.SHERPA_ONNX_ROOT) yield process.env.SHERPA_ONNX_ROOT;
  if (process.env.DSH_BIN_ROOT) yield process.env.DSH_BIN_ROOT;
  yield* walkFrom(process.argv?.[1] ? path.dirname(process.argv[1]) : '');
  // worker 线程里 argv 只有 [node]，从工作目录和自身位置也探一遍
  yield* walkFrom(process.cwd());
  yield* walkFrom(path.dirname(process.execPath));
}

function* walkFrom(start) {
  let dir = start;
  for (let i = 0; i < 8 && dir; i++) {
    yield dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/** Directory of an installed package, or '' — a worker thread cannot re-resolve it itself. */
export function packageDir(name) {
  for (const root of roots()) {
    if (!root) continue;
    const nm = path.join(root, 'node_modules', name);
    if (fs.existsSync(nm)) return nm;
  }
  try {
    return path.dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
  } catch {
    return '';
  }
}

export function loadPackage(name) {
  const tried = [];
  for (const root of roots()) {
    if (!root) continue;
    const nm = path.join(root, 'node_modules', name);
    if (!fs.existsSync(nm)) continue;
    tried.push(nm);
    try {
      return createRequire(path.join(root, 'noop.js'))(name);
    } catch (e) {
      tried.push(`${nm} -> ${e.code || e.message}`);
    }
  }
  try {
    return createRequire(import.meta.url)(name);
  } catch (e) {
    const err = new Error(`找不到依赖 ${name}（试过：${tried.join(' | ') || '无'}）: ${e.message}`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
}
