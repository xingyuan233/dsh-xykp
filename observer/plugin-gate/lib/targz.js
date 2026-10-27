/**
 * dsh-plugin-gate — minimal in-memory .tar.gz extraction.
 *
 * Pure module (node:zlib only). Used to scan npm tarballs without touching
 * disk and without spawning any process. Supports the classic ustar format
 * plus GNU long-name ('L') headers; PAX headers ('x'/'g') are skipped.
 * Path traversal entries are dropped and counted.
 */

import { gunzipSync } from "node:zlib";

const BLOCK = 512;

/** Round a byte length up to the next 512-byte block. */
function padded(size) {
  return Math.ceil(size / BLOCK) * BLOCK;
}

function isZeroBlock(buf) {
  for (let i = 0; i < BLOCK; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/** Read a null-terminated (or space-padded) ASCII field. */
function readField(buf, offset, length) {
  let end = offset;
  const stop = offset + length;
  while (end < stop && buf[end] !== 0 && buf[end] !== 32) end += 1;
  return buf.subarray(offset, end).toString("utf8");
}

/** Parse an octal field (some writers use base-256 for big sizes). */
function parseOctal(buf, offset, length) {
  const raw = buf.subarray(offset, offset + length);
  if (raw.length > 0 && (raw[0] & 0x80) !== 0) {
    let value = 0;
    for (let i = 0; i < raw.length; i++) {
      value = value * 256 + (i === 0 ? raw[i] & 0x7f : raw[i]);
    }
    return value;
  }
  const text = readField(buf, offset, length).trim();
  return text.length === 0 ? 0 : parseInt(text, 8);
}

/** Is this raw archive path a traversal or absolute escape attempt? */
function isUnsafePath(raw) {
  return raw.startsWith("/") || raw.startsWith("../") || raw.includes("/../") || raw.includes("\\");
}

/** Normalize an archive path to a safe relative POSIX-style path. */
function normalizePath(name) {
  let p = String(name).replace(/\\/g, "/");
  p = p.replace(/^\.[\\/]/g, "").replace(/^[a-zA-Z]:\//, "").replace(/^\/+/, "");
  const parts = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/**
 * Extract a .tar.gz buffer into an in-memory file list.
 * @param {Buffer} buffer - gzipped tarball bytes.
 * @param {{maxBytes?:number, maxFiles?:number}} [opts]
 * @returns {{files:Array<{path:string,size:number,data:Buffer}>, truncated:{files:number, bytes:number, traversal:number, pax:number}}}
 * @throws when the gzip stream cannot be decompressed within maxBytes.
 */
export function extractTarball(buffer, opts = {}) {
  const { maxBytes = 64 * 1024 * 1024, maxFiles = 2000 } = opts;
  let data;
  try {
    data = gunzipSync(buffer, { maxOutputLength: maxBytes });
  } catch (e) {
    throw new Error("targz: gunzip failed: " + e.message);
  }

  const files = [];
  const truncated = { files: 0, bytes: 0, traversal: 0, pax: 0 };
  let offset = 0;
  let longName = null;

  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break;

    const name = readField(header, 0, 100);
    const size = parseOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = readField(header, 345, 155);

    if (type === "L") {
      const nameBytes = data.subarray(offset + BLOCK, offset + BLOCK + size);
      longName = nameBytes.toString("utf8").replace(/\0.*$/, "");
      offset += BLOCK + padded(size);
      continue;
    }
    if (type === "x" || type === "g") {
      truncated.pax += 1;
      offset += BLOCK + padded(size);
      continue;
    }

    const raw = longName !== null ? longName : (prefix.length > 0 ? prefix + "/" + name : name);
    longName = null;
    const payloadLen = padded(size);

    if (type === "0" || type === "\u0000") {
      if (isUnsafePath(raw)) {
        truncated.traversal += 1;
        offset += BLOCK + payloadLen;
        continue;
      }
      const safe = normalizePath(raw);
      if (safe.length === 0) {
        truncated.traversal += 1;
        offset += BLOCK + payloadLen;
        continue;
      }
      if (files.length >= maxFiles) {
        truncated.files += 1;
        offset += BLOCK + payloadLen;
        continue;
      }
      const payloadStart = offset + BLOCK;
      const payloadEnd = payloadStart + size;
      offset += BLOCK + payloadLen;
      if (payloadEnd > data.length) {
        truncated.bytes += 1;
        continue;
      }
      files.push({ path: safe, size, data: data.subarray(payloadStart, payloadEnd) });
    } else {
      offset += BLOCK + payloadLen;
    }
  }

  return { files, truncated };
}
