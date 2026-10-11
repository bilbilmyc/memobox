import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfigPath, loadConfig, saveConfig } from "./config";

describe("config 文件（v2.4）", () => {
  test("不存在 / 损坏都按空配置（不抛错）", () => {
    expect(loadConfig(join(tmpdir(), "memobox-nope-dir", "c.json"))).toEqual({});
    const p = join(mkdtempSync(join(tmpdir(), "memobox-cfg-")), "bad.json");
    writeFileSync(p, "{ 这不是 json", "utf-8");
    expect(loadConfig(p)).toEqual({});
  });

  test("save → load 往返；目录不存在会顺手建", () => {
    const p = join(mkdtempSync(join(tmpdir(), "memobox-cfg-")), "sub", "c.json");
    saveConfig({ embedding: { base: "http://localhost:11434/v1", model: "bge-m3" } }, p);
    expect(loadConfig(p).embedding?.model).toBe("bge-m3");
  });

  test("MEMOBOX_CONFIG_PATH 覆盖默认位置", () => {
    const prev = process.env.MEMOBOX_CONFIG_PATH;
    process.env.MEMOBOX_CONFIG_PATH = "Z:/x/config.json";
    try {
      expect(defaultConfigPath()).toBe("Z:/x/config.json");
    } finally {
      if (prev === undefined) delete process.env.MEMOBOX_CONFIG_PATH;
      else process.env.MEMOBOX_CONFIG_PATH = prev;
    }
  });
});
