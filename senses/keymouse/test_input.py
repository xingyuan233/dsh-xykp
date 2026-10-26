"""input-mcp 交互测试：开一个置顶 Tk 窗口，发点击/长按/拖曳/连点/滚轮/按键，看它收到什么。"""
import threading
import time
import tkinter as tk

import server

events: list[tuple[int, str, object]] = []

root = tk.Tk()
root.title("input-mcp test")
root.geometry("600x400+200+200")
root.attributes("-topmost", True)
canvas = tk.Canvas(root, width=600, height=400, bg="white", highlightthickness=0)
canvas.pack()


def rec(kind, e=None):
    events.append((time.perf_counter(), kind, e))


root.bind("<ButtonPress-1>", lambda e: rec("down", e))
root.bind("<ButtonRelease-1>", lambda e: rec("up", e))
root.bind("<B1-Motion>", lambda e: rec("motion", e))
root.bind("<MouseWheel>", lambda e: rec("wheel", e))
root.bind("<KeyPress>", lambda e: rec("key", e))
root.update()


def pump(seconds: float = 0.15) -> None:
    end = time.perf_counter() + seconds
    while time.perf_counter() < end:
        root.update()
        time.sleep(0.002)


def summary(kind: str) -> str:
    return f"{kind}={sum(1 for e in events if e[1] == kind)}"


server.focus_window("input-mcp test")
root.focus_force()
server.move(300, 300)
pump(0.1)

# 1. 单击
events.clear()
server.click(300, 300)
pump(0.15)
print("click:", summary("down"), summary("up"))

# 2. 长按（用 GetAsyncKeyState 量真实按住时长）
events.clear()


def hold_duration(fn, timeout=3.0):
    state = {"down": False, "t0": None, "dt": None}
    t = threading.Thread(target=fn)
    t.start()
    end = time.perf_counter() + timeout
    while time.perf_counter() < end:
        down = bool(server.user32.GetAsyncKeyState(1) & 0x8000)
        if down and not state["down"]:
            state["down"], state["t0"] = True, time.perf_counter()
        elif not down and state["down"] and state["dt"] is None:
            state["dt"] = (time.perf_counter() - state["t0"]) * 1000
            break
        time.sleep(0.001)
    t.join()
    return state["dt"]


hold = hold_duration(lambda: server.long_press(300, 300, duration=0.35))
pump(0.15)
print(f"long_press: hold={hold:.0f}ms (期望 ~350)")

# 3. 连点（后台线程发，主线程 pump 收事件，量间隔）
events.clear()
t = threading.Thread(target=server.multi_click, args=(320, 320), kwargs={"count": 3, "interval": 0.1})
t.start()
pump(0.6)
t.join()
downs = [e for e in events if e[1] == "down"]
gaps = [round((downs[i + 1][0] - downs[i][0]) * 1000) for i in range(len(downs) - 1)]
print(f"multi_click: presses={len(downs)} gaps={gaps}ms (期望 3 次 / ~100ms)")

# 4. 拖曳（后台线程发，主线程 pump 收事件）
events.clear()
t = threading.Thread(target=server.drag, args=(250, 250, 450, 350), kwargs={"duration": 0.35, "steps": 20})
t.start()
pump(0.6)
t.join()
motions = [e for e in events if e[1] == "motion"]
ups = [e for e in events if e[1] == "up"]
last = motions[-1][2] if motions else None
p = server.wt.POINT()
server.user32.GetCursorPos(server.ctypes.byref(p))
print(f"drag: motion={len(motions)} up={len(ups)} end_client=({getattr(last,'x',None)},{getattr(last,'y',None)}) "
      f"end_screen=({p.x},{p.y}) (期望 450,350)")

# 5. 滚轮
events.clear()
server.scroll(2, x=300, y=300)
pump(0.15)
print("scroll:", summary("wheel"))

# 6. 组合键
events.clear()
server.key("ctrl+c")
pump(0.15)
print("key ctrl+c:", summary("key"))

# 7. 输入文本
events.clear()
server.type_text("ab", interval=0.03)
pump(0.2)
chars = "".join(getattr(e[2], "char", "") for e in events if e[1] == "key")
print("type_text:", repr(chars), f"({summary('key')})")

root.destroy()
