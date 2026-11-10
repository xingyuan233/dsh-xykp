#!/usr/bin/env python
"""input-mcp — 鼠标/键盘操作 MCP server（不依赖第三方库）。

两种投递方式：
    SendInput  —— move / click / multi_click / long_press / drag / scroll / key / type_text
                  会真的移动光标，事件进系统输入队列、跟着前台焦点走。
    PostMessage —— post_click / post_scroll / post_key / post_text
                  直接把消息发给指定窗口，光标不动、不抢前台，可操作后台窗口。

工具：
    move / click / multi_click / long_press / drag / scroll / key / type_text
    post_click / post_scroll / post_key / post_text
    focus_window / input_info

坐标默认是虚拟桌面物理像素；传 window 时 x,y 相对该窗口客户区。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import sys
import time

from mcp.server.mcpserver import MCPServer
from mcp.types import TextContent

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wt.LONG),
        ("dy", wt.LONG),
        ("mouseData", wt.DWORD),
        ("dwFlags", wt.DWORD),
        ("time", wt.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wt.WORD),
        ("wScan", wt.WORD),
        ("dwFlags", wt.DWORD),
        ("time", wt.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wt.DWORD),
        ("wParamL", wt.WORD),
        ("wParamH", wt.WORD),
    ]


class INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    _anonymous_ = ("u",)
    _fields_ = [("type", wt.DWORD), ("u", _U)]


INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_XDOWN = 0x0080
MOUSEEVENTF_XUP = 0x0100
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

BUTTONS = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}

# ── 窗口消息常量（PostMessage 直投，不动光标）─────────────────────────

WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK = 0x0201, 0x0202, 0x0203
WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK = 0x0204, 0x0205, 0x0206
WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK = 0x0207, 0x0208, 0x0209
WM_MOUSEWHEEL, WM_MOUSEHWHEEL = 0x020A, 0x020E
WM_KEYDOWN, WM_KEYUP, WM_CHAR = 0x0100, 0x0101, 0x0102
MK_LBUTTON, MK_RBUTTON, MK_MBUTTON = 0x0001, 0x0002, 0x0010
CWP_SKIPINVISIBLE, CWP_SKIPDISABLED, CWP_SKIPTRANSPARENT = 0x0001, 0x0002, 0x0004

BTN_MSG = {
    "left": (WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, MK_LBUTTON),
    "right": (WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK, MK_RBUTTON),
    "middle": (WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK, MK_MBUTTON),
}


class GUITHREADINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wt.DWORD),
        ("flags", wt.DWORD),
        ("hwndActive", wt.HWND),
        ("hwndFocus", wt.HWND),
        ("hwndCapture", wt.HWND),
        ("hwndMenuOwner", wt.HWND),
        ("hwndMoveSize", wt.HWND),
        ("hwndCaret", wt.HWND),
        ("rcCaret", wt.RECT),
    ]


user32.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
user32.PostMessageW.restype = wt.BOOL
user32.ChildWindowFromPointEx.argtypes = [wt.HWND, wt.POINT, wt.UINT]
user32.ChildWindowFromPointEx.restype = wt.HWND
user32.MapWindowPoints.argtypes = [wt.HWND, wt.HWND, ctypes.POINTER(wt.POINT), wt.UINT]
user32.MapVirtualKeyW.argtypes = [wt.UINT, wt.UINT]
user32.MapVirtualKeyW.restype = wt.UINT
user32.GetGUIThreadInfo.argtypes = [wt.DWORD, ctypes.POINTER(GUITHREADINFO)]
user32.GetGUIThreadInfo.restype = wt.BOOL
user32.IsChild.argtypes = [wt.HWND, wt.HWND]
user32.WindowFromPoint.argtypes = [wt.POINT]
user32.WindowFromPoint.restype = wt.HWND
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]

VK = {
    "backspace": 0x08, "tab": 0x09, "enter": 0x0D, "return": 0x0D,
    "shift": 0x10, "ctrl": 0x11, "control": 0x11, "alt": 0x12,
    "pause": 0x13, "capslock": 0x14, "esc": 0x1B, "escape": 0x1B,
    "space": 0x20, "pageup": 0x21, "pagedown": 0x22, "end": 0x23,
    "home": 0x24, "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "insert": 0x2D, "delete": 0x2E, "win": 0x5B,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}

user32.SendInput.argtypes = [wt.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SendInput.restype = wt.UINT
user32.GetCursorPos.argtypes = [ctypes.POINTER(wt.POINT)]
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]


def _send(*inputs: INPUT) -> None:
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    sent = user32.SendInput(n, arr, ctypes.sizeof(INPUT))
    if sent != n:
        raise OSError(f"SendInput 失败（{sent}/{n}），目标窗口可能权限更高（UIPI）")


def _mouse(flags: int, dx: int = 0, dy: int = 0, data: int = 0) -> INPUT:
    inp = INPUT()
    inp.type = INPUT_MOUSE
    inp.mi = MOUSEINPUT(dx, dy, data, flags, 0, 0)
    return inp


def _key(vk: int, scan: int = 0, flags: int = 0) -> INPUT:
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
    return inp


def _virtual_screen() -> tuple[int, int, int, int]:
    return (
        user32.GetSystemMetrics(76),  # SM_XVIRTUALSCREEN
        user32.GetSystemMetrics(77),
        user32.GetSystemMetrics(78),
        user32.GetSystemMetrics(79),
    )


def _abs(x: int, y: int) -> tuple[int, int]:
    vx, vy, vw, vh = _virtual_screen()
    nx = round((x - vx) * 65535 / max(1, vw - 1))
    ny = round((y - vy) * 65535 / max(1, vh - 1))
    return max(0, min(65535, nx)), max(0, min(65535, ny))


def _check(x: int, y: int) -> None:
    vx, vy, vw, vh = _virtual_screen()
    if not (vx <= x < vx + vw and vy <= y < vy + vh):
        raise ValueError(f"坐标 ({x},{y}) 不在屏幕内：{vw}x{vh} @ {vx},{vy}")


def _move(x: int, y: int) -> None:
    _check(x, y)
    nx, ny = _abs(x, y)
    _send(_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny))


# ── 窗口 ──────────────────────────────────────────────────────────────

def _frame_rect(hwnd: int) -> tuple[int, int, int, int]:
    r = wt.RECT()
    if ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(r), ctypes.sizeof(r)) != 0:
        user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def _client_rect(hwnd: int) -> tuple[int, int, int, int]:
    c = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(c))
    p = wt.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(p))
    return p.x, p.y, c.right, c.bottom


def _visible_windows() -> list[tuple[int, int, str]]:
    found: list[tuple[int, int, str]] = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _lp):
        if not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        r = wt.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return True
        w, h = r.right - r.left, r.bottom - r.top
        if w < 40 or h < 40:
            return True
        found.append((w * h, hwnd, buf.value))
        return True

    user32.EnumWindows(cb, 0)
    found.sort(reverse=True)
    return found


def _window_title(hwnd: int) -> str:
    n = user32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _find_window(spec: str) -> tuple[int, str]:
    """标题子串（不分大小写）或纯数字 hwnd；多个命中取面积最大的。"""
    s = str(spec).strip()
    if s.isdigit():
        hwnd = int(s)
        if not user32.IsWindow(hwnd):
            raise ValueError(f"hwnd={hwnd} 不是有效窗口")
        return hwnd, _window_title(hwnd)
    hits = [x for x in _visible_windows() if s.lower() in x[2].lower()]
    if not hits:
        raise ValueError(f"没有标题包含 {spec!r} 的可见窗口")
    _, hwnd, title = hits[0]
    return hwnd, title


def _point(x: int, y: int, window: str | None) -> tuple[int, int, str | None]:
    """window 给定时把客户区相对坐标换成屏幕绝对坐标。"""
    if not window:
        return x, y, None
    hwnd, title = _find_window(window)
    cx, cy, cw, ch = _client_rect(hwnd)
    if not (0 <= x < cw and 0 <= y < ch):
        raise ValueError(f"窗口 {title!r} 客户区只有 {cw}x{ch}，({x},{y}) 越界")
    return cx + x, cy + y, title


def _press(button: str, hold: float) -> None:
    down, up = BUTTONS[button]
    _send(_mouse(down))
    if hold > 0:
        time.sleep(hold)
    _send(_mouse(up))


# ── 直投窗口消息（PostMessage）──────────────────────────────────────

def _lparam(x: int, y: int) -> int:
    v = ((y & 0xFFFF) << 16) | (x & 0xFFFF)
    return v - 0x100000000 if v >= 0x80000000 else v


def _msg(hwnd: int, msg: int, wparam: int = 0, lparam: int = 0) -> None:
    """PostMessage 一条窗口消息（不阻塞、不移动光标）。"""
    if not user32.PostMessageW(hwnd, msg, wparam & 0xFFFFFFFF, lparam):
        raise OSError(f"PostMessageW 失败（msg=0x{msg:04X}），窗口可能已销毁或权限更高（UIPI）")


def _deepest_child(hwnd: int, x: int, y: int) -> tuple[int, int, int]:
    """从 hwnd 客户区坐标 (x,y) 往下钻到最深的可见子窗口，返回目标窗口自己的客户区坐标。

    不能用 CWP_SKIPTRANSPARENT：Chromium/WebView2 会铺一层 WS_EX_TRANSPARENT 的
    Intermediate D3D Window，带这个标志会在半路停住，消息根本到不了渲染窗口。
    """
    target, px, py = hwnd, x, y
    for _ in range(16):
        child = user32.ChildWindowFromPointEx(
            target, wt.POINT(px, py), CWP_SKIPINVISIBLE | CWP_SKIPDISABLED
        )
        if not child or child == target:
            break
        pt = (wt.POINT * 1)(wt.POINT(px, py))
        user32.MapWindowPoints(target, child, pt, 1)
        px, py = pt[0].x, pt[0].y
        target = child
    return target, px, py


def _target_client(
    window: str, x: int, y: int, child: bool = True
) -> tuple[int, int, str, int, int, int, int]:
    """window 客户区坐标 (x,y) → (顶层 hwnd, 收消息 hwnd, 标题, 目标客户区 x,y, 屏幕 x,y)。"""
    top, title = _find_window(window)
    cx, cy, cw, ch = _client_rect(top)
    x, y = int(x), int(y)
    if not (0 <= x < cw and 0 <= y < ch):
        raise ValueError(f"窗口 {title!r} 客户区只有 {cw}x{ch}，({x},{y}) 越界")
    sx, sy = cx + x, cy + y
    target, tx, ty = top, x, y
    if child:
        target, tx, ty = _deepest_child(top, x, y)
    return top, target, title, tx, ty, sx, sy


def _gui_focus(hwnd: int) -> int | None:
    """窗口所在线程的焦点子窗口（编辑框、浏览器渲染控件等）；没有焦点就返回 None。"""
    tid = user32.GetWindowThreadProcessId(hwnd, None)
    if not tid:
        return None
    gti = GUITHREADINFO()
    gti.cbSize = ctypes.sizeof(GUITHREADINFO)
    if not user32.GetGUIThreadInfo(tid, ctypes.byref(gti)) or not gti.hwndFocus:
        return None
    f = gti.hwndFocus
    return f if f == hwnd or user32.IsChild(hwnd, f) else None


def _input_target(hwnd: int) -> tuple[int, str]:
    """键盘消息目标：线程焦点子窗口 → 客户区中心的深层子窗口 → 顶层窗口。"""
    focus = _gui_focus(hwnd)
    if focus and focus != hwnd:
        return focus, "焦点子窗口"
    _, _, cw, ch = _client_rect(hwnd)
    if cw > 1 and ch > 1:
        child, _, _ = _deepest_child(hwnd, cw // 2, ch // 2)
        if child != hwnd:
            return child, "客户区中心子窗口"
    return focus or hwnd, "窗口本身"


def _key_lparam(vk: int, up: bool = False) -> int:
    scan = user32.MapVirtualKeyW(vk, 0) & 0xFF
    lp = 1 | (scan << 16)
    return lp | 0xC0000000 if up else lp


# ── 直投效果探测（auto：先直投，没反应再动鼠标）─────────────────────

gdi32 = ctypes.windll.gdi32


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


def _check_mode(mode: str) -> None:
    if mode not in ("auto", "post", "sendinput"):
        raise ValueError("mode 只能是 auto / post / sendinput")


def _win_pid(hwnd: int) -> int:
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def _grab(x: int, y: int, size: int = 160) -> bytes:
    """以 (x,y) 为中心截一块屏幕（物理像素），供直投效果探测比像素。"""
    left, top = int(x) - size // 2, int(y) - size // 2
    src = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(src)
    bmp = gdi32.CreateCompatibleBitmap(src, size, size)
    old = gdi32.SelectObject(mem, bmp)
    try:
        gdi32.BitBlt(mem, 0, 0, size, size, src, left, top, 0x00CC0020)  # SRCCOPY
        bi = BITMAPINFO()
        bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bi.bmiHeader.biWidth = size
        bi.bmiHeader.biHeight = -size
        bi.bmiHeader.biPlanes = 1
        bi.bmiHeader.biBitCount = 32
        buf = ctypes.create_string_buffer(size * size * 4)
        if not gdi32.GetDIBits(mem, bmp, 0, size, buf, ctypes.byref(bi), 0):
            return b""
        return buf.raw
    finally:
        gdi32.SelectObject(mem, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem)
        user32.ReleaseDC(0, src)


def _pixels_changed(a: bytes, b: bytes, tolerance: int = 15) -> bool:
    if not a or not b or len(a) != len(b):
        return False
    changed = 0
    for i in range(0, len(a), 4):
        if abs(a[i] - b[i]) + abs(a[i + 1] - b[i + 1]) + abs(a[i + 2] - b[i + 2]) > tolerance * 3:
            changed += 1
            if changed > 3:
                return True
    return False


def _process_windows(pid: int) -> set[int]:
    found: set[int] = set()

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _lp):
        if _win_pid(hwnd) == pid and user32.IsWindowVisible(hwnd):
            found.add(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return found


def _thread_capture(tid: int) -> int:
    if not tid:
        return 0
    gti = GUITHREADINFO()
    gti.cbSize = ctypes.sizeof(GUITHREADINFO)
    if user32.GetGUIThreadInfo(tid, ctypes.byref(gti)):
        return int(gti.hwndCapture or 0)
    return 0


def _hit_window(x: int, y: int) -> int:
    """屏幕点上真正可见的最上层窗口（用于判断像素探测是否读到目标自己）。"""
    return int(user32.WindowFromPoint(wt.POINT(int(x), int(y))) or 0)


def _probe(top: int, target: int, sx: int, sy: int, before_px: bytes, before_win: set[int]) -> bool:
    """直投有没有反应：目标线程鼠标捕获 / 目标自己露出来的局部像素变化 / 进程冒出新窗口。"""
    if _thread_capture(user32.GetWindowThreadProcessId(target, None)):
        return True
    hit = _hit_window(sx, sy)
    on_top = bool(hit) and (hit == top or hit == target or user32.IsChild(top, hit))
    if on_top and _pixels_changed(before_px, _grab(sx, sy)):
        return True
    return bool(_process_windows(_win_pid(top)) - before_win)


def _direct_click(
    x: int,
    y: int,
    button: str = "left",
    count: int = 1,
    interval: float = 0.05,
    hold: float = 0.0,
    window: str | None = None,
    child: bool = True,
) -> tuple[bool, str]:
    if button not in BTN_MSG:
        raise ValueError(f"button 只能是 {list(BTN_MSG)}")
    if not window:
        raise ValueError("直投点击必须给 window（标题子串或 hwnd）：消息只能发给具体窗口")
    top, target, title, tx, ty, sx, sy = _target_client(window, x, y, child)
    down, up, dbl, mk = BTN_MSG[button]
    lp = _lparam(tx, ty)
    count = max(1, int(count))
    hold = max(0.0, float(hold))
    before_px = _grab(sx, sy)
    before_win = _process_windows(_win_pid(top))
    _msg(target, WM_MOUSEMOVE, 0, lp)
    _msg(target, down, mk, lp)
    time.sleep(max(0.05, hold))
    effect = _probe(top, target, sx, sy, before_px, before_win)
    _msg(target, up, 0, lp)
    if count == 2:  # 双击：第二下用 DBLCLK 序列
        _msg(target, dbl, mk, lp)
        time.sleep(max(0.05, hold))
        _msg(target, up, 0, lp)
    else:
        for _ in range(1, count):
            time.sleep(max(0.0, float(interval)))
            _msg(target, down, mk, lp)
            if hold:
                time.sleep(hold)
            _msg(target, up, 0, lp)
    return effect, f"{button} click x{count} at client {tx},{ty} of {title!r} (hwnd={target})"


def _direct_long_press(
    x: int,
    y: int,
    duration: float = 0.6,
    button: str = "left",
    window: str | None = None,
    child: bool = True,
) -> tuple[bool, str]:
    if button not in BTN_MSG:
        raise ValueError(f"button 只能是 {list(BTN_MSG)}")
    if not window:
        raise ValueError("直投长按必须给 window")
    top, target, title, tx, ty, sx, sy = _target_client(window, x, y, child)
    down, up, _dbl, mk = BTN_MSG[button]
    lp = _lparam(tx, ty)
    before_px = _grab(sx, sy)
    before_win = _process_windows(_win_pid(top))
    _msg(target, WM_MOUSEMOVE, 0, lp)
    _msg(target, down, mk, lp)
    time.sleep(0.06)
    effect = _probe(top, target, sx, sy, before_px, before_win)
    rest = max(0.0, float(duration)) - 0.06
    if rest:
        time.sleep(rest)
    _msg(target, up, 0, lp)
    return effect, f"{button} long_press {duration}s at client {tx},{ty} of {title!r} (hwnd={target})"


def _direct_scroll(
    amount: int = 1,
    x: int | None = None,
    y: int | None = None,
    horizontal: bool = False,
    window: str | None = None,
    child: bool = True,
) -> tuple[bool, str]:
    if not window:
        raise ValueError("直投滚轮必须给 window")
    hwnd, title = _find_window(window)
    cx, cy, cw, ch = _client_rect(hwnd)
    if x is None or y is None:
        p = wt.POINT()
        user32.GetCursorPos(ctypes.byref(p))
        sx, sy = p.x, p.y
        target = hwnd
    else:
        if not (0 <= int(x) < cw and 0 <= int(y) < ch):
            raise ValueError(f"窗口 {title!r} 客户区只有 {cw}x{ch}，({x},{y}) 越界")
        sx, sy = cx + int(x), cy + int(y)
        target = _deepest_child(hwnd, int(x), int(y))[0] if child else hwnd
    before_px = _grab(sx, sy, 220)
    delta = int(amount) * 120
    msg = WM_MOUSEHWHEEL if horizontal else WM_MOUSEWHEEL
    _msg(target, msg, (delta << 16) & 0xFFFF0000, _lparam(sx, sy))
    time.sleep(0.06)
    effect = _pixels_changed(before_px, _grab(sx, sy, 220))
    return effect, (
        f"scroll {'horizontal' if horizontal else 'vertical'} {amount} "
        f"at screen {sx},{sy} -> {title!r} (hwnd={target})"
    )


def _direct_key(
    keys: str = "enter",
    window: str | None = None,
    hold: float = 0.05,
    child: bool = True,
) -> tuple[bool, str]:
    if not window:
        raise ValueError("直投按键必须给 window")
    parts = [p for p in keys.replace(" ", "").split("+") if p]
    if not parts:
        raise ValueError("keys 不能为空")
    vks = [_vk_for(p) for p in parts]
    hwnd, title = _find_window(window)
    target, via = _input_target(hwnd) if child else (hwnd, "顶层窗口")
    for vk in vks:
        _msg(target, WM_KEYDOWN, vk, _key_lparam(vk))
        time.sleep(0.01)
    time.sleep(max(0.0, float(hold)))
    for vk in reversed(vks):
        _msg(target, WM_KEYUP, vk, _key_lparam(vk, True))
        time.sleep(0.01)
    return True, f"key {keys} -> {title!r} (hwnd={target}, {via})"


def _direct_text(
    text: str,
    window: str | None = None,
    interval: float = 0.02,
    child: bool = True,
) -> tuple[bool, str]:
    if not window:
        raise ValueError("直投文本必须给 window")
    hwnd, title = _find_window(window)
    target, via = _input_target(hwnd) if child else (hwnd, "顶层窗口")
    data = text.encode("utf-16-le")
    count = 0
    for i in range(0, len(data), 2):
        unit = data[i] | (data[i + 1] << 8)
        if unit == 10:  # \n
            vk = 0x0D
            _msg(target, WM_KEYDOWN, vk, _key_lparam(vk))
            _msg(target, WM_CHAR, vk, _key_lparam(vk))
            _msg(target, WM_KEYUP, vk, _key_lparam(vk, True))
        else:
            _msg(target, WM_CHAR, unit, 1)
        count += 1
        if interval:
            time.sleep(max(0.0, float(interval)))
    return True, f"text {count} units -> {title!r} (hwnd={target}, {via})"


# ── MCP ───────────────────────────────────────────────────────────────

mcp = MCPServer(
    "input",
    instructions=(
        "Mouse and keyboard control via SendInput. Coordinates are virtual-screen "
        "physical pixels, or window-client-relative when `window` is given. "
        "Use click for taps, multi_click for rapid repeated taps, long_press for hold, "
        "drag for movement with the button down. Call focus_window before sending keys "
        "if the target is not already focused. When `window` is given, mouse and keyboard "
        "tools default to mode=auto: events are posted as window messages (no cursor "
        "movement, no focus steal); clicks fall back to real input if the target ignores "
        "them, keyboard does not. mode=post forces posting, mode=sendinput forces real input."
    ),
)


@mcp.tool()
def input_info() -> TextContent:
    """返回虚拟屏幕范围、当前光标位置、前台窗口标题。"""
    vx, vy, vw, vh = _virtual_screen()
    p = wt.POINT()
    user32.GetCursorPos(ctypes.byref(p))
    fg = user32.GetForegroundWindow()
    n = user32.GetWindowTextLengthW(fg)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(fg, buf, n + 1)
    return TextContent(
        type="text",
        text=(
            f"virtual_screen: {vw}x{vh} @ {vx},{vy}\n"
            f"cursor: {p.x},{p.y}\n"
            f"foreground: {buf.value}"
        ),
    )


@mcp.tool()
def move(x: int, y: int, window: str | None = None) -> TextContent:
    """把鼠标移动到 (x, y)。传 window 时坐标相对该窗口客户区。"""
    ax, ay, title = _point(x, y, window)
    _move(ax, ay)
    return TextContent(type="text", text=f"moved to {ax},{ay}" + (f" ({title})" if title else ""))


@mcp.tool()
def click(
    x: int,
    y: int,
    button: str = "left",
    count: int = 1,
    interval: float = 0.08,
    hold: float = 0.0,
    window: str | None = None,
    mode: str = "auto",
    child: bool = True,
) -> TextContent:
    """在 (x, y) 点击。count 是连点次数，interval 是间隔秒；hold 是每次按下保持时间。
    mode：auto=给了 window 时先直投窗口消息（不动光标），没反应再真实点击；post=只直投；sendinput=只真实输入。"""
    if button not in BUTTONS:
        raise ValueError(f"button 只能是 {list(BUTTONS)}")
    _check_mode(mode)
    if mode == "post" and not window:
        raise ValueError("mode=post 需要 window（消息只能发给具体窗口）")
    note = ""
    if window and mode != "sendinput":
        effect, info = _direct_click(x, y, button, count, interval, hold, window, child)
        if mode == "post" or effect:
            return TextContent(type="text", text=f"{info}；直投窗口消息，光标未移动")
        note = "；直投无反应，已回退真实点击"
    ax, ay, title = _point(x, y, window)
    _move(ax, ay)
    time.sleep(0.01)
    for i in range(max(1, count)):
        _press(button, max(0.0, hold))
        if i + 1 < count:
            time.sleep(max(0.0, interval))
    return TextContent(
        type="text",
        text=f"{button} click x{max(1, count)} at {ax},{ay}"
        + (f" ({title})" if title else "")
        + note,
    )


@mcp.tool()
def multi_click(
    x: int,
    y: int,
    count: int = 3,
    interval: float = 0.08,
    button: str = "left",
    window: str | None = None,
    mode: str = "auto",
    child: bool = True,
) -> TextContent:
    """连点：在 (x, y) 快速点 count 次。"""
    return click(
        x=x, y=y, button=button, count=count, interval=interval, window=window, mode=mode, child=child,
    )


@mcp.tool()
def long_press(
    x: int,
    y: int,
    duration: float = 0.6,
    button: str = "left",
    window: str | None = None,
    mode: str = "auto",
    child: bool = True,
) -> TextContent:
    """长按：在 (x, y) 按下并保持 duration 秒后松开。mode 同 click。"""
    if button not in BUTTONS:
        raise ValueError(f"button 只能是 {list(BUTTONS)}")
    _check_mode(mode)
    if mode == "post" and not window:
        raise ValueError("mode=post 需要 window（消息只能发给具体窗口）")
    note = ""
    if window and mode != "sendinput":
        effect, info = _direct_long_press(x, y, duration, button, window, child)
        if mode == "post" or effect:
            return TextContent(type="text", text=f"{info}；直投窗口消息，光标未移动")
        note = "；直投无反应，已回退真实点击"
    ax, ay, title = _point(x, y, window)
    _move(ax, ay)
    time.sleep(0.01)
    _press(button, max(0.01, min(30.0, duration)))
    return TextContent(
        type="text",
        text=f"{button} long_press {duration}s at {ax},{ay}"
        + (f" ({title})" if title else "")
        + note,
    )


@mcp.tool()
def drag(
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    duration: float = 0.4,
    steps: int = 24,
    button: str = "left",
    window: str | None = None,
) -> TextContent:
    """拖曳：从 (x1,y1) 按下，平滑移动到 (x2,y2)（duration 秒），松开。"""
    if button not in BUTTONS:
        raise ValueError(f"button 只能是 {list(BUTTONS)}")
    ax1, ay1, title = _point(x1, y1, window)
    ax2, ay2, _ = _point(x2, y2, window)
    steps = max(1, steps)
    _move(ax1, ay1)
    time.sleep(0.02)
    down, up = BUTTONS[button]
    nx1, ny1 = _abs(ax1, ay1)
    nx2, ny2 = _abs(ax2, ay2)
    _send(_mouse(down))
    step_sleep = max(0.0, duration) / steps
    for i in range(1, steps + 1):
        t = i / steps
        nx = round(nx1 + (nx2 - nx1) * t)
        ny = round(ny1 + (ny2 - ny1) * t)
        _send(_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny))
        if step_sleep:
            time.sleep(step_sleep)
    _send(_mouse(up))
    return TextContent(
        type="text",
        text=f"{button} drag {ax1},{ay1} -> {ax2},{ay2} in {duration}s"
        + (f" ({title})" if title else ""),
    )


@mcp.tool()
def scroll(
    amount: int = 1,
    x: int | None = None,
    y: int | None = None,
    horizontal: bool = False,
    window: str | None = None,
    mode: str = "auto",
    child: bool = True,
) -> TextContent:
    """滚轮：amount 正数向上/向右，负数向下/向左；给了 x,y 会先移过去。mode 同 click。"""
    _check_mode(mode)
    if mode == "post" and not window:
        raise ValueError("mode=post 需要 window（消息只能发给具体窗口）")
    note = ""
    if window and mode != "sendinput":
        effect, info = _direct_scroll(amount, x, y, horizontal, window, child)
        if mode == "post" or effect:
            return TextContent(type="text", text=f"{info}；直投窗口消息，光标未移动")
        note = "；直投无反应，已回退真实滚轮"
    if x is not None and y is not None:
        ax, ay, _ = _point(x, y, window)
        _move(ax, ay)
        time.sleep(0.01)
    flags = MOUSEEVENTF_HWHEEL if horizontal else MOUSEEVENTF_WHEEL
    _send(_mouse(flags, 0, 0, int(amount) * 120))
    return TextContent(
        type="text",
        text=f"scroll {'horizontal' if horizontal else 'vertical'} {amount}{note}",
    )


def _vk_for(name: str) -> int:
    key = name.strip().lower()
    if key in VK:
        return VK[key]
    if len(key) == 1:
        if key.isalpha():
            return ord(key.upper())
        if key.isdigit():
            return ord(key)
        scan = user32.VkKeyScanW(ord(key))
        if scan == -1:
            raise ValueError(f"不认识的按键：{name!r}")
        return scan & 0xFF
    raise ValueError(f"不认识的按键：{name!r}")


@mcp.tool()
def key(
    keys: str = "enter",
    hold: float = 0.05,
    window: str | None = None,
    mode: str = "auto",
    child: bool = True,
) -> TextContent:
    """按一个键或组合键，如 "enter"、"a"、"ctrl+c"、"alt+tab"。
    不给 window 走真实输入（目标要在前台）；给了 window 且 mode=auto/post 就直接投给该窗口，不切前台。"""
    _check_mode(mode)
    if mode == "post" and not window:
        raise ValueError("mode=post 需要 window（消息只能发给具体窗口）")
    if window and mode in ("auto", "post"):
        _ok, info = _direct_key(keys, window, hold, child)
        return TextContent(type="text", text=f"{info}；直投窗口消息，未切前台")
    parts = [p for p in keys.replace(" ", "").split("+") if p]
    if not parts:
        raise ValueError("keys 不能为空")
    vks = [_vk_for(p) for p in parts]
    for vk in vks:
        _send(_key(vk))
        time.sleep(0.01)
    time.sleep(max(0.0, hold))
    for vk in reversed(vks):
        _send(_key(vk, flags=KEYEVENTF_KEYUP))
        time.sleep(0.01)
    return TextContent(type="text", text=f"key {keys} (hold {hold}s)")


@mcp.tool()
def type_text(
    text: str,
    interval: float = 0.02,
    window: str | None = None,
    mode: str = "auto",
    child: bool = True,
) -> TextContent:
    """输入一段文本（SendInput Unicode，支持中文）。
    不给 window 走真实输入；给了 window 且 mode=auto/post 就直接投给该窗口，不切前台。"""
    _check_mode(mode)
    if mode == "post" and not window:
        raise ValueError("mode=post 需要 window（消息只能发给具体窗口）")
    if window and mode in ("auto", "post"):
        _ok, info = _direct_text(text, window, interval, child)
        return TextContent(type="text", text=f"{info}；直投窗口消息，未切前台")
    data = text.encode("utf-16-le")
    count = 0
    for i in range(0, len(data), 2):
        unit = data[i] | (data[i + 1] << 8)
        if unit == 10:  # \n
            _send(_key(0x0D))
            _send(_key(0x0D, flags=KEYEVENTF_KEYUP))
        else:
            _send(_key(0, unit, KEYEVENTF_UNICODE))
            _send(_key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
        count += 1
        if interval:
            time.sleep(interval)
    return TextContent(type="text", text=f"typed {count} chars")


@mcp.tool()
def focus_window(window: str) -> TextContent:
    """把标题包含 window 的窗口切到前台（必要时还原）。"""
    hwnd, title = _find_window(window)
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    fg = user32.GetForegroundWindow()
    tid_fg = user32.GetWindowThreadProcessId(fg, None)
    tid_me = kernel32.GetCurrentThreadId()
    user32.AttachThreadInput(tid_me, tid_fg, True)
    user32.SetForegroundWindow(hwnd)
    user32.BringWindowToTop(hwnd)
    user32.AttachThreadInput(tid_me, tid_fg, False)
    x, y, w, h = _client_rect(hwnd)
    return TextContent(type="text", text=f"focused {title!r} client {w}x{h} @ {x},{y}")


# ── 命令行入口：改完直接调，不用重启宿主 ──────────────────────────────
#
#   python server.py --cli click '{"x":120,"y":80,"window":"记事本"}'
#   python server.py --cli type_text '{"text":"hello","window":"记事本"}'
#   python server.py --cli click '{"x":1,"y":1,"window":"记事本","mode":"post"}'

_CLI = {
    "click": click,
    "multi_click": multi_click,
    "long_press": long_press,
    "scroll": scroll,
    "key": key,
    "type_text": type_text,
}


def _run_cli(argv: list[str]) -> int:
    import json

    if not argv:
        print(f"用法: python server.py --cli <{'|'.join(_CLI)}> '<json 参数>'", file=sys.stderr)
        return 2
    fn = _CLI.get(argv[0])
    if fn is None:
        print(f"未知工具 {argv[0]!r}；可用：{', '.join(_CLI)}", file=sys.stderr)
        return 2
    try:
        kwargs = json.loads(argv[1]) if len(argv) > 1 else {}
        out = fn(**kwargs)
    except Exception as exc:  # noqa: BLE001 - CLI 只回报错误
        print(f"出错：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(getattr(out, "text", out))
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--cli":
        raise SystemExit(_run_cli(sys.argv[2:]))
    mcp.run(transport="stdio")
