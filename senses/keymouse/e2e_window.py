"""给 MCP 端到端测试用的置顶窗口：记录点击坐标到 click_log.txt，15 秒后自动关闭。"""
import pathlib
import tkinter as tk

LOG = pathlib.Path(__file__).with_name("click_log.txt")

root = tk.Tk()
root.title("input-mcp e2e")
root.geometry("400x300+100+100")
root.attributes("-topmost", True)
canvas = tk.Canvas(root, width=400, height=300, bg="#224466", highlightthickness=0)
canvas.pack()

LOG.write_text("", encoding="utf-8")


def on_click(event):
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"{event.x},{event.y}\n")


root.bind("<Button-1>", on_click)
root.after(15000, root.destroy)
root.mainloop()
