"""在真终端（pty）里跑 just wildgoose，改服务端代码，检查：自动重启并恢复服务；改回去再重启一次；
最后按 Ctrl+C：退出码 0、没有报错、终端模式恢复。

运行：python3 app/e2e/watch.py（在哪个目录都行）。端口用 5182。会临时改 app/src/build.ts，结束时一定改回。
"""
import os
import pty
import select
import sys
import termios
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, "app/src/build.ts")
BANNER = "归雁 · 双均线工作台：http://127.0.0.1:5182"
original = open(TARGET, encoding="utf-8").read()

pid, fd = pty.fork()
if pid == 0:
    os.chdir(ROOT)
    os.execvp("just", ["just", "wildgoose", "5182"])

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

def up():
    try:
        urllib.request.urlopen("http://127.0.0.1:5182/", timeout=1)
        return True
    except Exception:
        return False

def wait_banners(n, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        drain(0.3)
        if out.decode(errors="replace").count(BANNER) >= n and up():
            return True
    return False

ok = True
try:
    ok &= wait_banners(1)
    print("启动：", ok)
    with open(TARGET, "a", encoding="utf-8") as f:
        f.write("\n// watch-probe\n")
    r = wait_banners(2)
    print("改代码后自动重启并恢复服务：", r)
    ok &= r
finally:
    open(TARGET, "w", encoding="utf-8").write(original)
r = wait_banners(3)
print("改回去后又重启：", r)
ok &= r
drain(0.5)
os.write(fd, b"\x03")  # 终端里的 Ctrl+C
drain(4)
try:
    lflag = termios.tcgetattr(fd)[3]
    restored = bool(lflag & termios.ISIG) and bool(lflag & termios.ICANON)
except termios.error:
    restored = False
try:
    done, status = os.waitpid(pid, os.WNOHANG)
except ChildProcessError:
    done, status = pid, 0
if done == 0:
    print("按 Ctrl+C 后进程还在：杀掉")
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    code = None
else:
    code = os.waitstatus_to_exitcode(status)
text = out.decode(errors="replace")
print("退出码：", code, "| 输出里有 error：", "error" in text, "| 终端模式恢复：", restored)
ok &= code == 0 and "error" not in text and restored
assert open(TARGET, encoding="utf-8").read() == original, "build.ts 没改回去！"
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
