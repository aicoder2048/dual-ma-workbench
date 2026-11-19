"""在真终端（pty）里跑 just wildgoose，按 Ctrl+C，检查：没有 error、退出码 0、终端模式恢复。

运行：python3 app/e2e/ctrl_c.py（从项目根目录）。端口用 5180，避免撞上正在用的服务。
"""
import os
import pty
import select
import sys
import termios
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(ROOT)
    os.execvp("just", ["just", "wildgoose", "5180"])

out = b""
def drain(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                out += os.read(fd, 4096)
            except OSError:
                return

for _ in range(40):
    drain(0.5)
    try:
        urllib.request.urlopen("http://127.0.0.1:5180/", timeout=1)
        break
    except Exception:
        pass
drain(0.5)
os.write(fd, b"\x03")  # 终端里的 Ctrl+C
drain(3)
lflag_after = termios.tcgetattr(fd)[3]
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
text = out.decode(errors="replace")
print(text)
print("exit =", code)
restored = bool(lflag_after & termios.ISIG) and bool(lflag_after & termios.ICANON)
print("终端模式已恢复 =", restored)
ok = code == 0 and "error" not in text and "已停止" in text and restored
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
