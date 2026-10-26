#!/usr/bin/env python
"""screen-mcp — 屏幕截图 MCP server：直接返回图片内容，不写任何文件。

抓屏用 dxcam（DXGI Desktop Duplication），编码在内存里完成，工具结果是
MCP 的 image content block。没有 PNG 落盘、没有 read_image、没有临时文件。

用法（stdio MCP）：
    python server.py

工具：
    screenshot(region?, window?, client, fmt, quality, max_side)
    screen_info()   # 显示器 + 可见窗口列表，帮 agent 选 --window
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import sys
import threading
import time

import cv2
import dxcam
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
_dwm = ctypes.windll.dwmapi


def _frame_rect(hwnd: int) -> tuple[int, int, int, int]:
    """窗口的可见外框（去掉 Win10/11 的隐形边框和阴影）。"""
    r = wt.RECT()
    if _dwm.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(r), ctypes.sizeof(r)) != 0:
        _u.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def _client_rect(hwnd: int) -> tuple[int, int, int, int]:
    """窗口客户区（游戏内容区）。"""
    c = wt.RECT()
    _u.GetClientRect(hwnd, ctypes.byref(c))
    p = wt.POINT(0, 0)
    _u.ClientToScreen(hwnd, ctypes.byref(p))
    return p.x, p.y, c.right, c.bottom


def _visible_windows() -> list[tuple[int, int, str, int]]:
    """(面积, hwnd, 标题, ...) 按面积降序。"""
    found: list[tuple[int, int, str]] = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _lp):
        if not _u.IsWindowVisible(hwnd) or _u.IsIconic(hwnd):
            return True
        n = _u.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        _u.GetWindowTextW(hwnd, buf, n + 1)
        r = wt.RECT()
        if not _u.GetWindowRect(hwnd, ctypes.byref(r)):
            return True
        w, h = r.right - r.left, r.bottom - r.top
        if w < 40 or h < 40:
            return True
        found.append((w * h, hwnd, buf.value))
        return True

    _u.EnumWindows(cb, 0)
    found.sort(reverse=True)
    return found


def _find_window(substr: str) -> tuple[int, str]:
    hits = [x for x in _visible_windows() if substr.lower() in x[2].lower()]
    if not hits:
        raise ValueError(f"没有标题包含 {substr!r} 的可见窗口")
    _, hwnd, title = hits[0]
    return hwnd, title


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
        "Call screen_info first when you need to discover window titles or monitor size."
    ),
)


@mcp.tool()
def screen_info() -> str:
    """列出显示器尺寸和当前可见窗口（标题、位置、大小），用于挑选要截图的窗口。"""
    lines = []
    try:
        info = dxcam.output_info()
        lines.append(f"outputs: {info}")
    except Exception as exc:
        lines.append(f"outputs: (unavailable: {exc})")
    lines.append("windows (largest first):")
    for area, hwnd, title in _visible_windows()[:15]:
        x, y, w, h = _frame_rect(hwnd)
        lines.append(f"  [{w}x{h} @ {x},{y}] {title}")
    return "\n".join(lines)


@mcp.tool()
def screenshot(
    region: str | None = None,
    window: str | None = None,
    client: bool = True,
    fmt: str = "png",
    quality: int = 95,
    max_side: int = 1568,
) -> list:
    """截一张图并直接返回图片（不落盘）。

    Args:
        region: "x,y,w,h"（物理像素，相对主屏左上角）。为空且 window 也为空时截主屏全屏。
        window: 窗口标题子串；取面积最大的匹配窗口。与 region 二选一。
        client: window 模式下是否只取客户区（游戏内容区），默认 True。
        fmt: "png"（默认，适合文字/UI）或 "jpg"（快，适合追帧）。
        quality: jpg 质量 1-100。
        max_side: 长边上限，超过则用 INTER_AREA 缩小；<=0 表示不缩。
    """
    t0 = time.perf_counter()
    title = None
    if window:
        hwnd, title = _find_window(window)
        x, y, w, h = _client_rect(hwnd) if client else _frame_rect(hwnd)
    elif region:
        parts = [int(p) for p in region.replace(" ", "").split(",")]
        if len(parts) != 4:
            raise ValueError("region 需要 x,y,w,h")
        x, y, w, h = parts
    else:
        frame = SCREEN.grab()
        x, y, w, h = 0, 0, frame.shape[1], frame.shape[0]

    frame = SCREEN.grab()
    H, W = frame.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        raise ValueError(f"region 不在屏幕内：({x},{y},{w},{h})，屏幕 {W}x{H}")

    crop_w, crop_h = x1 - x0, y1 - y0
    img = frame[y0:y1, x0:x1]
    scale = 1.0
    if max_side and max(img.shape[1], img.shape[0]) > max_side:
        scale = max_side / max(img.shape[1], img.shape[0])
        img = cv2.resize(
            img,
            (max(1, round(img.shape[1] * scale)), max(1, round(img.shape[0] * scale))),
            interpolation=cv2.INTER_AREA,
        )

    fmt = fmt.lower()
    if fmt in ("jpg", "jpeg"):
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
        out_fmt = "jpeg"
    else:
        ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, 1])
        out_fmt = "png"
    if not ok:
        raise RuntimeError("图片编码失败")

    data = buf.tobytes()
    meta = TextContent(
        type="text",
        text=(
            f"capture region={x0},{y0},{crop_w},{crop_h} "
            f"image={img.shape[1]}x{img.shape[0]} scale={scale:.4f}"
            + (f" window={title!r}" if title else "")
        ),
    )
    print(
        f"screen-mcp: {out_fmt} {img.shape[1]}x{img.shape[0]} {len(data)}B "
        f"{(time.perf_counter() - t0) * 1000:.1f}ms"
        + (f" window={title!r}" if title else ""),
        file=sys.stderr,
    )
    return [meta, Image(data=data, format=out_fmt)]


if __name__ == "__main__":
    _set_dpi_aware()
    try:
        SCREEN.warm()
    except Exception as exc:
        print(f"screen-mcp: warmup failed: {exc}", file=sys.stderr)
    mcp.run(transport="stdio")
