#!/usr/bin/env python
"""input-mcp — 鼠标/键盘操作 MCP server（SendInput，不依赖第三方库）。

工具：
    move / click / multi_click / long_press / drag / scroll / key / type_text
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


def _find_window(substr: str) -> tuple[int, str]:
    hits = [x for x in _visible_windows() if substr.lower() in x[2].lower()]
    if not hits:
        raise ValueError(f"没有标题包含 {substr!r} 的可见窗口")
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


# ── MCP ───────────────────────────────────────────────────────────────

mcp = MCPServer(
    "input",
    instructions=(
        "Mouse and keyboard control via SendInput. Coordinates are virtual-screen "
        "physical pixels, or window-client-relative when `window` is given. "
        "Use click for taps, multi_click for rapid repeated taps, long_press for hold, "
        "drag for movement with the button down. Call focus_window before sending keys "
        "if the target is not already focused."
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
) -> TextContent:
    """在 (x, y) 点击。count 是连点次数，interval 是间隔秒；hold 是每次按下保持时间。"""
    if button not in BUTTONS:
        raise ValueError(f"button 只能是 {list(BUTTONS)}")
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
        + (f" ({title})" if title else ""),
    )


@mcp.tool()
def multi_click(
    x: int,
    y: int,
    count: int = 3,
    interval: float = 0.08,
    button: str = "left",
    window: str | None = None,
) -> TextContent:
    """连点：在 (x, y) 快速点 count 次。"""
    return click(x=x, y=y, button=button, count=count, interval=interval, window=window)


@mcp.tool()
def long_press(
    x: int,
    y: int,
    duration: float = 0.6,
    button: str = "left",
    window: str | None = None,
) -> TextContent:
    """长按：在 (x, y) 按下并保持 duration 秒后松开。"""
    if button not in BUTTONS:
        raise ValueError(f"button 只能是 {list(BUTTONS)}")
    ax, ay, title = _point(x, y, window)
    _move(ax, ay)
    time.sleep(0.01)
    _press(button, max(0.01, min(30.0, duration)))
    return TextContent(
        type="text",
        text=f"{button} long_press {duration}s at {ax},{ay}"
        + (f" ({title})" if title else ""),
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
) -> TextContent:
    """滚轮：amount 正数向上/向右，负数向下/向左；给了 x,y 会先移过去。"""
    if x is not None and y is not None:
        ax, ay, _ = _point(x, y, window)
        _move(ax, ay)
        time.sleep(0.01)
    flags = MOUSEEVENTF_HWHEEL if horizontal else MOUSEEVENTF_WHEEL
    _send(_mouse(flags, 0, 0, int(amount) * 120))
    return TextContent(type="text", text=f"scroll {'horizontal' if horizontal else 'vertical'} {amount}")


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
def key(keys: str = "enter", hold: float = 0.05) -> TextContent:
    """按一个键或组合键，如 "enter"、"a"、"ctrl+c"、"alt+tab"。"""
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
def type_text(text: str, interval: float = 0.02) -> TextContent:
    """输入一段文本（SendInput Unicode，支持中文）。"""
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


if __name__ == "__main__":
    mcp.run(transport="stdio")
