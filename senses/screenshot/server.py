#!/usr/bin/env python
"""screen-mcp — 截图 MCP server：图片直接返回，不落盘。

两种抓法（capture 参数）：
- desktop：dxcam（DXGI Desktop Duplication）抓整屏再裁剪。看到的就是「屏幕上现在是什么」，
  窗口被遮挡会截到遮挡物，最小化会停更。
- window：直接读窗口自己的画面，靠 PrintWindow(PW_RENDERFULLCONTENT) → BitBlt 兜底。
  窗口被遮挡、在后台也能截；DirectX 独占全屏 / 部分 GPU 合成窗口可能返回空白，auto 会退回 desktop。
- auto：给了 window 就先试 window，失败再 desktop。

用法（stdio MCP）：
    python server.py

工具：
    screenshot(region?, window?, capture, client, child, fmt, quality, max_side)
    screen_info()   # 显示器 + 可见窗口列表（带 hwnd），帮 agent 挑 window
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import sys
import threading
import time

import cv2
import dxcam
import numpy as np
from mcp.server.mcpserver import Image, MCPServer
from mcp.types import TextContent

# stdout 是 MCP 协议通道，只留 UTF-8；日志一律走 stderr
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_SILENT)


def _set_dpi_aware() -> None:
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass


_u = ctypes.windll.user32
_gdi = ctypes.windll.gdi32
_dwm = ctypes.windll.dwmapi

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
BI_RGB = 0
PW_CLIENTONLY = 0x00000001
PW_RENDERFULLCONTENT = 0x00000002
DWMWA_EXTENDED_FRAME_BOUNDS = 9

# PrintWindow 对无响应窗口会同步阻塞；单次尝试超时后换下一种方式。
PRINT_TIMEOUT = 1.5

_u.GetDC.restype = wt.HDC
_u.GetDC.argtypes = [wt.HWND]
_u.GetWindowDC.restype = wt.HDC
_u.GetWindowDC.argtypes = [wt.HWND]
_u.ReleaseDC.argtypes = [wt.HWND, wt.HDC]
_u.PrintWindow.argtypes = [wt.HWND, wt.HDC, wt.UINT]
_u.PrintWindow.restype = wt.BOOL
_u.GetClientRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
_u.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
_u.ClientToScreen.argtypes = [wt.HWND, ctypes.POINTER(wt.POINT)]
_u.IsWindow.argtypes = [wt.HWND]
_u.IsWindowVisible.argtypes = [wt.HWND]
_u.IsIconic.argtypes = [wt.HWND]
_u.GetWindowTextLengthW.argtypes = [wt.HWND]
_u.GetWindowTextLengthW.restype = ctypes.c_int
_u.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
_u.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]

ENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
_u.EnumWindows.argtypes = [ENUMPROC, wt.LPARAM]
_u.EnumChildWindows.argtypes = [wt.HWND, ENUMPROC, wt.LPARAM]

_gdi.CreateCompatibleDC.restype = wt.HDC
_gdi.CreateCompatibleDC.argtypes = [wt.HDC]
_gdi.DeleteDC.argtypes = [wt.HDC]
_gdi.SelectObject.restype = wt.HANDLE
_gdi.SelectObject.argtypes = [wt.HDC, wt.HANDLE]
_gdi.DeleteObject.argtypes = [wt.HANDLE]
_gdi.BitBlt.argtypes = [wt.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                        wt.HDC, ctypes.c_int, ctypes.c_int, wt.DWORD]
_gdi.BitBlt.restype = wt.BOOL

_dwm.DwmGetWindowAttribute.argtypes = [wt.HWND, wt.DWORD, ctypes.c_void_p, wt.DWORD]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD),
        ("biWidth", wt.LONG),
        ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD),
        ("biBitCount", wt.WORD),
        ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD),
        ("biXPelsPerMeter", wt.LONG),
        ("biYPelsPerMeter", wt.LONG),
        ("biClrUsed", wt.DWORD),
        ("biClrImportant", wt.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wt.DWORD * 3)]


_gdi.CreateDIBSection.restype = wt.HANDLE
_gdi.CreateDIBSection.argtypes = [
    wt.HDC,
    ctypes.POINTER(BITMAPINFO),
    wt.UINT,
    ctypes.POINTER(ctypes.c_void_p),
    wt.HANDLE,
    wt.DWORD,
]


# ── 几何 ──────────────────────────────────────────────────────────


def _frame_rect(hwnd: int) -> tuple[int, int, int, int]:
    """窗口的可见外框（去掉 Win10/11 的隐形边框和阴影）。"""
    r = wt.RECT()
    if _dwm.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(r), ctypes.sizeof(r)) != 0:
        _u.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def _window_rect(hwnd: int) -> tuple[int, int, int, int]:
    """GetWindowRect 原始外框（BitBlt / PrintWindow 的坐标系）。"""
    r = wt.RECT()
    _u.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def _client_rect(hwnd: int) -> tuple[int, int, int, int]:
    """窗口客户区（游戏内容区）在屏幕上的位置与大小。"""
    c = wt.RECT()
    _u.GetClientRect(hwnd, ctypes.byref(c))
    p = wt.POINT(0, 0)
    _u.ClientToScreen(hwnd, ctypes.byref(p))
    return p.x, p.y, c.right, c.bottom


# ── 窗口枚举 ──────────────────────────────────────────────────────


def _window_title(hwnd: int) -> str:
    n = _u.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    _u.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _visible_windows() -> list[tuple[int, int, str, int]]:
    """(面积, hwnd, 标题, ...) 按面积降序。"""
    found: list[tuple[int, int, str]] = []

    @ENUMPROC
    def cb(hwnd, _lp):
        if not _u.IsWindowVisible(hwnd) or _u.IsIconic(hwnd):
            return True
        title = _window_title(hwnd)
        if not title:
            return True
        r = wt.RECT()
        if not _u.GetWindowRect(hwnd, ctypes.byref(r)):
            return True
        w, h = r.right - r.left, r.bottom - r.top
        if w < 40 or h < 40:
            return True
        found.append((w * h, hwnd, title))
        return True

    _u.EnumWindows(cb, 0)
    found.sort(reverse=True)
    return found


def _visible_children(hwnd: int) -> list[tuple[int, int, str]]:
    """(面积, hwnd, 类名)，按面积降序；模拟器的画面通常在最大的子窗口里。"""
    found: list[tuple[int, int, str]] = []

    @ENUMPROC
    def cb(child, _lp):
        if not _u.IsWindowVisible(child):
            return True
        r = wt.RECT()
        if not _u.GetWindowRect(child, ctypes.byref(r)):
            return True
        w, h = r.right - r.left, r.bottom - r.top
        if w < 40 or h < 40:
            return True
        buf = ctypes.create_unicode_buffer(256)
        _u.GetClassNameW(child, buf, 256)
        found.append((w * h, child, buf.value))
        return True

    _u.EnumChildWindows(hwnd, cb, 0)
    found.sort(reverse=True)
    return found


def _find_window(spec: str) -> tuple[int, str]:
    """标题子串（大小写不敏感）或纯数字 hwnd；多个命中取面积最大的。"""
    s = str(spec).strip()
    if s.isdigit():
        hwnd = int(s)
        if not _u.IsWindow(hwnd):
            raise ValueError(f"hwnd={hwnd} 不是有效窗口")
        return hwnd, _window_title(hwnd)
    hits = [x for x in _visible_windows() if s.lower() in x[2].lower()]
    if not hits:
        raise ValueError(f"没有标题包含 {spec!r} 的可见窗口（用 screen_info 看列表）")
    _, hwnd, title = hits[0]
    return hwnd, title


# ── GDI 抓取 ──────────────────────────────────────────────────────


def _dib(w: int, h: int):
    """建一张 w×h 的 32 位自上而下 DIB，返回 (memdc, bitmap, oldbitmap, bits)。"""
    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = w
    bmi.bmiHeader.biHeight = -h  # 负值 = 自上而下，省一次翻转
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bmi.bmiHeader.biCompression = BI_RGB

    screen_dc = _u.GetDC(0)
    if not screen_dc:
        raise OSError("GetDC(0) 失败")
    bits = ctypes.c_void_p()
    try:
        hbmp = _gdi.CreateDIBSection(
            screen_dc, ctypes.byref(bmi), DIB_RGB_COLORS, ctypes.byref(bits), None, 0
        )
        mem = _gdi.CreateCompatibleDC(screen_dc)
    finally:
        _u.ReleaseDC(0, screen_dc)
    if not hbmp or not mem:
        raise OSError("DIB / 内存 DC 创建失败")
    old = _gdi.SelectObject(mem, hbmp)
    return mem, hbmp, old, bits


def _dib_pixels(w: int, h: int, bits) -> "np.ndarray":
    raw = ctypes.string_at(bits.value, w * h * 4)
    arr = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 4)
    return np.ascontiguousarray(arr[:, :, :3])  # BGRA → BGR


def _dib_release(mem, hbmp, old) -> None:
    try:
        _gdi.SelectObject(mem, old)
    finally:
        if hbmp:
            _gdi.DeleteObject(hbmp)
        if mem:
            _gdi.DeleteDC(mem)


def _capture_printwindow(hwnd: int, w: int, h: int, client: bool) -> "np.ndarray":
    mem, hbmp, old, bits = _dib(w, h)
    try:
        flags = PW_RENDERFULLCONTENT | (PW_CLIENTONLY if client else 0)
        _u.PrintWindow(hwnd, mem, flags)
        return _dib_pixels(w, h, bits)
    finally:
        _dib_release(mem, hbmp, old)


def _capture_bitblt(hwnd: int, w: int, h: int, client: bool) -> "np.ndarray":
    """way.py 同款：直接 BitBlt 窗口 DC。被遮挡也能拿到窗口自己的表面。"""
    src = _u.GetDC(hwnd) if client else _u.GetWindowDC(hwnd)
    if not src:
        raise OSError("拿不到窗口 DC")
    try:
        mem, hbmp, old, bits = _dib(w, h)
        try:
            if not _gdi.BitBlt(mem, 0, 0, w, h, src, 0, 0, SRCCOPY):
                raise OSError("BitBlt 失败")
            return _dib_pixels(w, h, bits)
        finally:
            _dib_release(mem, hbmp, old)
    finally:
        _u.ReleaseDC(hwnd, src)


def _is_blank(img: "np.ndarray | None") -> bool:
    """单色画面（全黑/全白/全透明）视为抓取失败——真实内容几乎不会完全均匀。"""
    if img is None or img.size == 0:
        return True
    step = max(1, min(img.shape[0], img.shape[1]) // 64)
    sample = img[::step, ::step]
    return int(sample.max()) - int(sample.min()) <= 2


def _with_timeout(fn, timeout: float):
    """PrintWindow 可能卡住，放线程里跑，超时返回 None。"""
    box: dict = {}

    def run() -> None:
        try:
            box["value"] = fn()
        except Exception as exc:  # noqa: BLE001 - 交给调用方决定
            box["error"] = exc

    th = threading.Thread(target=run, daemon=True)
    th.start()
    th.join(timeout)
    if th.is_alive():
        return None
    if "error" in box:
        raise box["error"]
    return box.get("value")


def _grab_one(hwnd: int, client: bool, tried: list[str]) -> dict | None:
    """对单个窗口依次试 PrintWindow、BitBlt；返回第一张非空白画面。"""
    if client:
        x, y, w, h = _client_rect(hwnd)
    else:
        x, y, w, h = _window_rect(hwnd)
    if w <= 0 or h <= 0:
        tried.append("尺寸为 0（可能最小化了）")
        return None

    for method, fn in (
        ("printwindow", lambda: _capture_printwindow(hwnd, w, h, client)),
        ("bitblt", lambda: _capture_bitblt(hwnd, w, h, client)),
    ):
        try:
            img = _with_timeout(fn, PRINT_TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            tried.append(f"{method}: {exc}")
            continue
        if img is None:
            tried.append(f"{method}: 超时")
            continue
        if _is_blank(img):
            tried.append(f"{method}: 空白")
            continue
        return {"img": img, "method": method, "origin": (x, y), "size": (w, h)}

    # 有些窗口（模拟器）画面在子窗口里，PrintWindow 顶层只能拿到空壳
    for _area, child, cls in _visible_children(hwnd):
        if client:
            x, y, w, h = _client_rect(child)
        else:
            x, y, w, h = _window_rect(child)
        if w <= 0 or h <= 0:
            continue
        for method, fn in (
            ("printwindow", lambda: _capture_printwindow(child, w, h, client)),
            ("bitblt", lambda: _capture_bitblt(child, w, h, client)),
        ):
            try:
                img = _with_timeout(fn, PRINT_TIMEOUT)
            except Exception as exc:  # noqa: BLE001
                tried.append(f"child[{cls}] {method}: {exc}")
                continue
            if img is None or _is_blank(img):
                tried.append(f"child[{cls}] {method}: {'超时' if img is None else '空白'}")
                continue
            return {
                "img": img,
                "method": method,
                "origin": (x, y),
                "size": (w, h),
                "target": f"child[{cls}]",
            }
    return None


def _capture_window(hwnd: int, client: bool, child: bool = False) -> dict:
    """先顶层窗口，读不到再试最大子窗口（child=True 直接只试子窗口）。"""
    tried: list[str] = []
    if child:
        kids = _visible_children(hwnd)
        if not kids:
            raise ValueError("该窗口没有可见子窗口，child=true 用不了")
        _area, only, cls = kids[0]
        got = _grab_one(only, client, tried)
        if got:
            got["target"] = f"child[{cls}]"
            return got
        raise ValueError("子窗口抓不到画面：" + "；".join(tried[-6:]))

    got = _grab_one(hwnd, client, tried)
    if got:
        got.setdefault("target", "window")
        return got
    raise ValueError("PrintWindow/BitBlt 都拿不到画面（独占全屏或 GPU 合成窗口）：" +
                     "；".join(tried[-6:]))


# ── dxcam 桌面复制 ────────────────────────────────────────────────


class Screen:
    """常驻的 dxcam camera；只抓整屏，按 region 切，避免因窗口移动重建。

    空闲 15 秒会释放 DXGI 复制会话——桌面复制是每个输出独占的，常驻会挡住
    别的 dxcam 进程。释放后下次调用重建只要 ~13ms。
    """

    IDLE_RELEASE_SECONDS = 15.0

    def __init__(self) -> None:
        self._cam = None
        self._last = None
        self._lock = threading.Lock()
        self._last_used = 0.0
        self._reaper = None

    def _ensure(self) -> None:
        if self._cam is None:
            self._cam = dxcam.create(output_color="BGR")
            first = self._cam.grab()  # 首次 DDA 初始化
            if first is not None:
                self._last = first
            self._last_used = time.monotonic()

    def _start_reaper(self) -> None:
        if self._reaper is not None:
            return

        def loop() -> None:
            while True:
                time.sleep(5)
                with self._lock:
                    if (
                        self._cam is not None
                        and time.monotonic() - self._last_used > self.IDLE_RELEASE_SECONDS
                    ):
                        try:
                            self._cam.release()
                        except Exception:
                            pass
                        self._cam = None

        self._reaper = threading.Thread(target=loop, daemon=True)
        self._reaper.start()

    def warm(self) -> None:
        with self._lock:
            self._ensure()
        self._start_reaper()

    def grab(self):
        with self._lock:
            self._ensure()
            frame = self._cam.grab()
            if frame is not None:
                self._last = frame
            elif self._last is not None:
                frame = self._last
            if frame is None:
                raise RuntimeError("没有拿到画面（屏幕受保护或暂时没有新帧）")
            self._last_used = time.monotonic()
            return frame


SCREEN = Screen()

mcp = MCPServer(
    "screen",
    instructions=(
        "Capture the Windows desktop, a screen region, or a window, and return the image. "
        "Nothing is written to disk. Use png for text/UI (lossless); use jpg for speed. "
        "capture='window' reads the window's own surface (works while covered); "
        "capture='desktop' crops the composited screen (topmost only). "
        "Call screen_info first when you need to discover window titles or monitor size."
    ),
)


@mcp.tool()
def screen_info() -> str:
    """列出显示器尺寸和当前可见窗口（hwnd、位置、大小），用于挑选要截图的窗口。"""
    lines = []
    try:
        info = dxcam.output_info()
        lines.append(f"outputs: {info}")
    except Exception as exc:  # noqa: BLE001
        lines.append(f"outputs: (unavailable: {exc})")
    lines.append("windows (largest first):")
    for _area, hwnd, title in _visible_windows()[:15]:
        x, y, w, h = _frame_rect(hwnd)
        kids = _visible_children(hwnd)
        extra = f" children={len(kids)}" if kids else ""
        lines.append(f"  [{w}x{h} @ {x},{y}] hwnd={hwnd} {title!r}{extra}")
    return "\n".join(lines)


def _encode(img, fmt: str, quality: int) -> tuple[bytes, str]:
    fmt = (fmt or "png").lower()
    if fmt in ("jpg", "jpeg"):
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
        out_fmt = "jpeg"
    else:
        ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, 1])
        out_fmt = "png"
    if not ok:
        raise RuntimeError("图片编码失败")
    return buf.tobytes(), out_fmt


@mcp.tool()
def screenshot(
    region: str | None = None,
    window: str | None = None,
    capture: str = "auto",
    client: bool = True,
    child: bool = False,
    fmt: str = "png",
    quality: int = 95,
    max_side: int = 1568,
) -> list:
    """截一张图并直接返回图片（不落盘）。

    Args:
        region: "x,y,w,h"（物理像素，相对主屏左上角）。为空且 window 也为空时截主屏全屏。
        window: 窗口标题子串（大小写不敏感）或纯数字 hwnd；多个命中取面积最大的。与 region 二选一。
        capture: "auto"（默认）/ "desktop"（裁桌面，被遮挡就截到遮挡物）/ "window"（直接读窗口画面，被遮挡也能截）。
        client: window 模式下只取客户区（游戏内容区），默认 True。
        child: window 模式下直接抓最大的子窗口（模拟器/内嵌画面）。
        fmt: "png"（默认，适合文字/UI）或 "jpg"（快，适合追帧）。
        quality: jpg 质量 1-100。
        max_side: 长边上限，超过则用 INTER_AREA 缩小；<=0 表示不缩。
    """
    t0 = time.perf_counter()
    mode = (capture or "auto").lower()
    if mode not in ("auto", "desktop", "window"):
        raise ValueError("capture 只能是 auto / desktop / window")
    if region and window:
        raise ValueError("region 和 window 只能给一个")

    title = None
    hwnd = None
    method = None
    target = None
    note = None
    img = None
    origin = (0, 0)
    size = (0, 0)

    if window:
        hwnd, title = _find_window(window)
        if _u.IsIconic(hwnd):
            note = "窗口已最小化，窗口画面可能抓不到"
        if mode != "desktop":
            try:
                got = _capture_window(hwnd, client, child)
            except Exception as exc:  # noqa: BLE001
                if mode == "window":
                    raise
                note = f"窗口抓取失败（{exc}），已退回桌面裁剪（被遮挡会截到遮挡物）"
            else:
                img = got["img"]
                method = got["method"]
                target = got.get("target", "window")
                origin = got["origin"]
                size = got["size"]

    if img is None:
        if region:
            parts = [int(p) for p in region.replace(" ", "").split(",")]
            if len(parts) != 4:
                raise ValueError("region 需要 x,y,w,h")
            x, y, w, h = parts
        elif window:
            x, y, w, h = _client_rect(hwnd) if client else _frame_rect(hwnd)
        else:
            frame = SCREEN.grab()
            x, y, w, h = 0, 0, frame.shape[1], frame.shape[0]

        frame = SCREEN.grab()
        H, W = frame.shape[:2]
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(W, x + w), min(H, y + h)
        if x1 <= x0 or y1 <= y0:
            raise ValueError(f"region 不在屏幕内：({x},{y},{w},{h})，屏幕 {W}x{H}")
        img = frame[y0:y1, x0:x1]
        origin = (x0, y0)
        size = (x1 - x0, y1 - y0)

    crop_w, crop_h = size
    scale = 1.0
    if max_side and max(img.shape[1], img.shape[0]) > max_side:
        scale = max_side / max(img.shape[1], img.shape[0])
        img = cv2.resize(
            img,
            (max(1, round(img.shape[1] * scale)), max(1, round(img.shape[0] * scale))),
            interpolation=cv2.INTER_AREA,
        )

    data, out_fmt = _encode(img, fmt, quality)

    parts = [
        f"capture={'window' if method else 'desktop'}",
        f"region={origin[0]},{origin[1]},{crop_w},{crop_h}",
        f"image={img.shape[1]}x{img.shape[0]}",
        f"scale={scale:.4f}",
    ]
    if method:
        parts.append(f"method={method}")
    if target:
        parts.append(f"target={target}")
    if hwnd:
        parts.append(f"hwnd={hwnd}")
    if title:
        parts.append(f"window={title!r}")
    if note:
        parts.append(f"note={note}")
    meta_text = " ".join(parts)

    print(
        f"screen-mcp: {out_fmt} {img.shape[1]}x{img.shape[0]} {len(data)}B "
        f"{(time.perf_counter() - t0) * 1000:.1f}ms {meta_text}",
        file=sys.stderr,
    )
    return [TextContent(type="text", text=meta_text), Image(data=data, format=out_fmt)]


if __name__ == "__main__":
    _set_dpi_aware()
    try:
        SCREEN.warm()
    except Exception as exc:  # noqa: BLE001
        print(f"screen-mcp: warmup failed: {exc}", file=sys.stderr)
    mcp.run(transport="stdio")
