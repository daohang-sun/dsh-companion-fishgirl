#!/usr/bin/env python3
"""把 TeleAgent/updream 重绘的自制家具导入 CabinWorld，并摆进小鲸鱼家。

素材来源：C:/Users/sdhxa/.local/share/TeleAgent/TeleAgent的工作空间/家具_*.png
这批图按「主体上半居中、底部 25% 留白」生成，实际文件底部多出 32px 水印带；
本脚本只取上半目标尺寸，不做缩放，保留原始像素画风。

流程：
1. 裁掉水印带，输出 16 张成品 PNG 到 assets/cabin/furniture/；
2. 通过桥的 POST /v1/furniture 走原版家具导入接口（不改游戏源码）；
3. 把自制家具层改为 floor（不挡路），写入 data/layouts/home-grid-layout.json。

TeleAgent 工作空间里的原图不会被删除或覆盖。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

PLUGIN = Path(__file__).resolve().parents[1]
PROJECT = PLUGIN.parent
SOURCE = Path("C:/Users/sdhxa/.local/share/TeleAgent/TeleAgent的工作空间")
OUT = PLUGIN / "assets" / "cabin" / "furniture"
GAME = Path("D:/CabinWorld")
DATA = GAME / "data"
BRIDGE_JSON = DATA / "bridge.json"
LIBRARY = DATA / "saves" / "furniture-made" / "library.json"
LAYOUT = DATA / "layouts" / "home-grid-layout.json"
HOME_GRID = GAME / "game" / "assets" / "home-grid.json"
PACKING = GAME / "game" / "assets" / "home-grid-packing.json"

PPU = 2
CELL = 32

# key -> (源文件名, 目标宽, 目标高, 家具名, 占格宽, 占格深)
FURNITURE = {
    "garden_empty":      ("家具_G01_空菜畦_256x128.png",  256, 128, "海味菜园·翻土", 4, 2),
    "garden_growing":    ("家具_G02_生长菜畦_256x128.png", 256, 128, "海味菜园·嫩芽", 4, 2),
    "garden_mature":     ("家具_G03_成熟菜畦_256x128.png", 256, 128, "海味菜园·丰收", 4, 2),
    "diary_desk":        ("家具_D01_鱼鱼日记角_128x64.png", 128, 64, "鱼鱼日记角", 2, 1),
    "diary_closed":      ("家具_D02_合上日记本_64x64.png",  64, 64, "合上的日记本", 1, 1),
    "sea_painting":      ("家具_P01_鲸鱼海景画_64x64.png",  64, 64, "小鲸鱼海景画", 1, 1),
    "painting_cottage":  ("家具_P02_海边小屋画_64x64.png",  64, 64, "海边小屋画", 1, 1),
    "painting_coral":    ("家具_P03_珊瑚鱼群画_64x64.png",  64, 64, "珊瑚鱼群画", 1, 1),
    "fish_conch_stool":  ("家具_I01_海螺小凳_64x64.png",   64, 64, "海螺小凳", 1, 1),
    "fish_coral_pot":    ("家具_I02_珊瑚花盆_64x64.png",   64, 64, "珊瑚花盆", 1, 1),
    "fish_fish_plush":   ("家具_I03_小鱼抱枕_64x64.png",   64, 64, "小鱼抱枕", 1, 1),
    "fish_music_box":    ("家具_I04_海洋八音盒_64x64.png", 64, 64, "海洋八音盒", 1, 1),
    "fish_ocean_clock":  ("家具_I05_海洋挂钟_64x64.png",   64, 64, "海洋挂钟", 1, 1),
    "fish_pearl_box":    ("家具_I06_珍珠小盒_64x64.png",   64, 64, "珍珠小盒", 1, 1),
    "fish_shell_lamp":   ("家具_I07_贝壳小灯_64x64.png",   64, 64, "贝壳小灯", 1, 1),
    "fish_starfish_cushion": ("家具_I08_海星坐垫_64x64.png", 64, 64, "海星坐垫", 1, 1),
}

# 小鲸鱼家地板空位（格坐标）。row13 的 x8/12/19 留给新增的日记本与两幅画。
PLACEMENTS = [
    ("placed_made_garden",   "user-garden_mature",   [4, 13]),
    ("placed_made_diary",    "user-diary_desk",     [10, 13]),
    ("placed_made_closed",   "user-diary_closed",   [8, 13]),
    ("placed_made_painting", "user-sea_painting",   [14, 13]),
    ("placed_made_cottage",  "user-painting_cottage", [12, 13]),
    ("placed_made_coral_art","user-painting_coral", [19, 13]),
    ("placed_made_conch",    "user-fish_conch_stool", [15, 13]),
    ("placed_made_coral",    "user-fish_coral_pot", [16, 13]),
    ("placed_made_plush",    "user-fish_fish_plush", [17, 13]),
    ("placed_made_clock",    "user-fish_ocean_clock", [18, 13]),
    ("placed_made_lamp",     "user-fish_shell_lamp", [4, 11]),
    ("placed_made_pearl",    "user-fish_pearl_box", [5, 11]),
    ("placed_made_music",    "user-fish_music_box", [6, 11]),
    ("placed_made_cushion",  "user-fish_starfish_cushion", [7, 11]),
]


def build_images() -> dict[str, Path]:
    OUT.mkdir(parents=True, exist_ok=True)
    made = {}
    for key, (filename, width, height, _name, _w, _d) in FURNITURE.items():
        src = SOURCE / filename
        if not src.exists():
            raise RuntimeError(f"找不到 TeleAgent 素材：{src}")
        with Image.open(src) as im:
            rgba = im.convert("RGBA")
        if rgba.width < width or rgba.height < height:
            raise RuntimeError(f"素材尺寸不足：{filename} {rgba.size} < ({width},{height})")
        # 只取上半目标区域：TeleAgent 图底部 32px 是 AI 生成水印带。
        sprite = rgba.crop((0, 0, width, height))
        dst = OUT / f"{key}.png"
        sprite.save(dst)
        made[key] = dst
    return made


def specs_from() -> list[dict]:
    specs = []
    for key, (_filename, _w, _h, name, width, depth) in FURNITURE.items():
        specs.append({
            "id": key,
            "name": name,
            "width": width,
            "depth": depth,
            "pixelsPerUnit": PPU,
            "rotatable": False,
            "views": {"S": {"image": key}},
            "actions": [],
            "_imageKey": key,
        })
    return specs


def reset_made_library() -> None:
    """清掉旧的自制家具条目，让同 ID 的新图能重新导入（旧 PNG 文件保留）。"""
    if not LIBRARY.exists():
        return
    backup = LIBRARY.with_suffix(".json.bak-before-teleagent")
    if not backup.exists():
        shutil.copy2(LIBRARY, backup)
    doc = json.loads(LIBRARY.read_text(encoding="utf-8"))
    kept = {k: v for k, v in doc.get("assets", {}).items() if not str(k).startswith("user-")}
    removed = len(doc.get("assets", {})) - len(kept)
    doc["assets"] = kept
    tmp = LIBRARY.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, LIBRARY)
    print(f"  旧自制家具条目已清空：{removed} 件（备份 {backup.name}）")


def import_specs(specs: list[dict], images: dict[str, Path]) -> None:
    if not BRIDGE_JSON.exists():
        raise RuntimeError(f"找不到桥连接信息：{BRIDGE_JSON}；请先启动 start.cmd")
    info = json.loads(BRIDGE_JSON.read_text(encoding="utf-8"))
    url = info["url"].rstrip("/") + "/v1/furniture"
    token = info["token"]
    for spec in specs:
        key = spec.pop("_imageKey")
        raw = images[key].read_bytes()
        body = json.dumps({
            "spec": spec,
            "images": {key: base64.b64encode(raw).decode("ascii")},
        }).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        })
        result: dict = {}
        for _attempt in range(60):
            try:
                with urllib.request.urlopen(req, timeout=40) as resp:
                    result = json.loads(resp.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as exc:
                if exc.code == 503:  # 游戏刚启动，桥还没连上。
                    time.sleep(0.5)
                    continue
                result = {"ok": False, "error": str(exc)}
                break
            except Exception as exc:
                result = {"ok": False, "error": str(exc)}
                break
        ok = bool(result.get("ok"))
        note = result.get("error", result.get("asset", ""))
        print(f"  {'OK ' if ok else 'FAIL'} {key}: {note}")
        if not ok:
            raise RuntimeError(f"家具导入失败：{key} {note}")


def patch_library() -> None:
    if not LIBRARY.exists():
        raise RuntimeError(f"没有找到自制家具库：{LIBRARY}")
    doc = json.loads(LIBRARY.read_text(encoding="utf-8"))
    changed = 0
    for asset in doc.get("assets", {}).values():
        if str(asset.get("id", "")).startswith("user-") and asset.get("layer") != "floor":
            asset["layer"] = "floor"
            changed += 1
    tmp = LIBRARY.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, LIBRARY)
    print(f"  自制家具层改为 floor：{changed} 件")


def write_layout() -> None:
    base = json.loads(HOME_GRID.read_text(encoding="utf-8"))
    positions = {item["id"]: list(item["cell"]) for item in base.get("catalog", [])}
    layout = {
        "version": 1,
        "scene": base.get("scene", "xiaojingyu-home"),
        "positions": positions,
        "groups": base.get("defaultGroups", []),
        "instances": {},
        "stored": [],
        "offsets": {},
        "facings": {},
        "map_revision": base.get("revision"),
    }
    if LAYOUT.exists():
        try:
            saved = json.loads(LAYOUT.read_text(encoding="utf-8"))
            if isinstance(saved, dict) and isinstance(saved.get("positions"), dict):
                backup = LAYOUT.with_suffix(".json.bak-before-teleagent")
                if not backup.exists():
                    shutil.copy2(LAYOUT, backup)
                for key in ("positions", "instances", "groups", "stored", "offsets", "facings"):
                    if isinstance(saved.get(key), type(layout.get(key))):
                        layout[key] = saved[key]
                for item_id, cell in positions.items():
                    layout["positions"].setdefault(item_id, cell)
        except (OSError, ValueError) as exc:
            print(f"  旧布局读取失败，按默认布局重建：{exc}")
    # 清掉不再存在的旧自制实例，避免库重置后校验失败。
    for item_id in list(layout.get("instances", {})):
        if not str(item_id).startswith("placed_made_"):
            continue
        if str(layout["instances"][item_id]) not in {f"user-{k}" for k in FURNITURE}:
            layout["instances"].pop(item_id, None)
            layout["positions"].pop(item_id, None)
            layout["offsets"].pop(item_id, None)
    try:
        origin = json.loads(PACKING.read_text(encoding="utf-8")).get("origin", [28, 21])
    except (OSError, ValueError):
        origin = [28, 21]
    for item_id, asset_id, cell in PLACEMENTS:
        layout.setdefault("instances", {})[item_id] = asset_id
        layout.setdefault("positions", {})[item_id] = list(cell)
        layout.setdefault("offsets", {})[item_id] = [int(origin[0]), int(origin[1])]
        layout["stored"] = [x for x in layout.get("stored", []) if x != item_id]
    LAYOUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = LAYOUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(layout, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, LAYOUT)
    print(f"  布局已写入：{LAYOUT}（{len(PLACEMENTS)} 件自制家具）")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-only", action="store_true", help="只裁图，不导入或摆场")
    parser.add_argument("--reset-only", action="store_true", help="只清掉旧自制家具条目（游戏启动前执行）")
    parser.add_argument("--place-only", action="store_true", help="只写布局文件")
    args = parser.parse_args()

    if args.reset_only:
        reset_made_library()
        return 0

    if not args.place_only:
        print("裁切 TeleAgent 新家具图…")
        images = build_images()
        print(f"  输出 {len(images)} 张 PNG 到 {OUT}")
    if args.build_only:
        return 0
    if not args.place_only:
        print("重置旧自制家具条目…")
        reset_made_library()
        print("通过原版桥导入家具…")
        import_specs(specs_from(), images if not args.place_only else {})
        patch_library()
    print("写入小鲸鱼家布置…")
    write_layout()
    return 0


if __name__ == "__main__":
    sys.exit(main())
