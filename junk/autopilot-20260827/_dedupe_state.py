from pathlib import Path

p = Path.cwd() / "AUTOPILOT_STATE.md"
text = p.read_bytes().decode("utf-8")
lines = text.split("\n")
out = []
removed = 0
for ln in lines:
    if "iter 22 (2026-08-26)" in ln and out and out[-1].strip() == ln.strip():
        removed += 1
        continue
    out.append(ln)
p.write_bytes("\n".join(out).encode("utf-8"))
count = sum(1 for ln in out if "iter 22 (2026-08-26)" in ln)
print(f"removed={removed}, remaining_iter22_entries={count}, total_lines={len(out)}")
