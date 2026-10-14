#!/usr/bin/env python3
"""生成 PWA 图标 PNG（仅 stdlib: zlib/struct/math）。

视觉与 public/icon.svg 对齐（100 单位坐标系）：
  圆角矩形黄底 + 黑色内描边 + 白色书签带（黑描边）

用法：python3 scripts/gen-icons.py
输出：packages/web/public/{icon-192,icon-512,icon-maskable-512,apple-touch-icon-180}.png
"""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "packages" / "web" / "public"

YELLOW = (255, 210, 63)
INK = (20, 20, 20)
PAPER = (255, 253, 247)

# 100 单位坐标系（与 icon.svg 一致）
INSET = 4.0        # 圆角矩形到画布边距
RADIUS = 14.0      # 圆角半径
STROKE = 7.0       # 描边宽度
GLYPH = [(32.0, 22.0), (68.0, 22.0), (68.0, 78.0), (50.0, 64.0), (32.0, 78.0)]


def sdf_round_rect(px: float, py: float, x0: float, y0: float, x1: float, y1: float, r: float) -> float:
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    qx, qy = abs(px - cx) - hx, abs(py - cy) - hy
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def _dist_point_seg(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L = vx * vx + vy * vy
    t = 0.0 if L == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def _inside_poly(px: float, py: float, pts: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > py) != (y2 > py) and px < (x2 - x1) * (py - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def sdf_poly(px: float, py: float, pts: list[tuple[float, float]]) -> float:
    d = min(
        _dist_point_seg(px, py, *pts[i], *pts[(i + 1) % len(pts)]) for i in range(len(pts))
    )
    return -d if _inside_poly(px, py, pts) else d


def render(size: int, maskable: bool) -> list[bytearray]:
    """返回 RGBA 行。maskable=True 时满幅（无透明）, glyph 缩到安全区 78%。"""
    gut = size / 100.0
    rows: list[bytearray] = []
    # glyph 缩放（maskable 需留安全边距）: 以中心为原点缩放
    scale = 0.78 if maskable else 1.0
    glyph = [((x - 50.0) * scale + 50.0, (y - 50.0) * scale + 50.0) for x, y in GLYPH]

    for j in range(size):
        row = bytearray()
        py = (j + 0.5) / gut
        for i in range(size):
            px = (i + 0.5) / gut
            if maskable:
                # 满幅: 背景填满画布, 外框贴着边（maskable 会被裁成任意形状）
                d = sdf_round_rect(px, py, 0.0, 0.0, 100.0, 100.0, 0.0)
                r, g, b, a = (*YELLOW, 255)
            else:
                d = sdf_round_rect(px, py, INSET, INSET, 100 - INSET, 100 - INSET, RADIUS)
                if d > STROKE / 2:
                    row += bytes((0, 0, 0, 0))
                    continue
                r, g, b, a = (*YELLOW, 255)
            # 外描边
            if abs(d) <= STROKE / 2:
                r, g, b = INK
            # 书签带（叠加在外框内）
            dg = sdf_poly(px, py, glyph)
            if abs(dg) <= STROKE / 2:
                r, g, b = INK
            elif dg < 0:
                r, g, b = PAPER
            row += bytes((r, g, b, a))
        rows.append(row)
    return rows


def write_png(path: Path, size: int, rows: list[bytearray]) -> None:
    raw = b"".join(b"\x00" + bytes(r) for r in rows)  # filter type 0
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # RGBA

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon-180.png", 180, True),  # iOS 图标不接受透明, 用满幅
    ]
    for name, size, maskable in targets:
        rows = render(size, maskable)
        write_png(OUT / name, size, rows)
        print(f"{name}: {size}x{size} (maskable={maskable})")


if __name__ == "__main__":
    main()
