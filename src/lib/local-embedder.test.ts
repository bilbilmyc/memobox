import { describe, expect, mock, test } from "bun:test";
import {
  LOCAL_EMBED_DIM,
  LOCAL_EMBED_MODEL,
  createLocalEmbedder,
  isTransformersMissing,
  resetLocalExtractor,
} from "./local-embedder";

/**
 * 假 transformers.js：pipeline 记录请求时的 env.remoteHost，
 * failHosts 里的源抛错（测换源回退）。模型不真加载、不碰网络。
 */
const calls: string[] = [];
const encoded: { text: string; pooling: string }[] = [];
const failHosts = new Set<string>();
const fakeEnv = { remoteHost: "", cacheDir: "" };

mock.module("@huggingface/transformers", () => ({
  pipeline: async () => {
    calls.push(fakeEnv.remoteHost);
    if (failHosts.has(fakeEnv.remoteHost)) throw new Error(`boom ${fakeEnv.remoteHost}`);
    return async (text: string, options: { pooling: string }) => { encoded.push({ text, pooling: options.pooling }); return { data: new Float32Array([0.6, 0.8]) }; };
  },
  env: fakeEnv,
}));

const reset = () => {
  resetLocalExtractor();
  calls.length = 0;
  encoded.length = 0;
  failHosts.clear();
  fakeEnv.remoteHost = "";
};

/** Float32 精度下 0.6/0.8 会变成 0.60000002…——用近似断言 */
const expectUnitVec = async (e: { embed(t: string): Promise<number[]> }, text = "你好") => {
  const v = await e.embed(text);
  expect(v).toHaveLength(2);
  expect(v[0]).toBeCloseTo(0.6);
  expect(v[1]).toBeCloseTo(0.8);
};

describe("内置嵌入模型（v2.5，mock transformers）", () => {
  test("同一查询的模型结果可复用且返回独立数组；LRU 有界，失败可以重试", async () => {
    reset(); const provider = createLocalEmbedder();
    const [first, second] = await Promise.all([provider.embedQuery!("重复查询"), provider.embedQuery!("重复查询")]);
    expect(encoded.length).toBe(1); first[0] = 99; expect(second[0]).toBeCloseTo(.6);
    for (let i = 0; i < 128; i++) await provider.embedQuery!("查询" + i);
    await provider.embedQuery!("重复查询"); expect(encoded.length).toBe(130);
    reset(); failHosts.add("https://hf-mirror.com"); failHosts.add("https://huggingface.co");
    await expect(provider.embedQuery!("重试查询")).rejects.toThrow(); failHosts.clear();
    expect((await provider.embedQuery!("重试查询"))[0]).toBeCloseTo(.6);
  });
  test("BGE 使用官方 CLS 池化；只给检索查询加指令，预处理空间与旧 mean 向量分离", async () => {
    reset(); const provider = createLocalEmbedder();
    await provider.embed("文档原文"); await provider.embedQuery!("查询文本");
    expect(encoded).toEqual([{ text: "文档原文", pooling: "cls" }, { text: "为这个句子生成表示以用于检索相关文章：查询文本", pooling: "cls" }]);
    expect(provider.space).toContain("v2:cls:query-instruction"); expect(provider.minimumSimilarity).toBe(.45);
  });
  test("embed 返回归一化向量；默认源是 hf-mirror；模型单例只加载一次", async () => {
    reset();
    const e = createLocalEmbedder();
    expect(e.model).toBe(LOCAL_EMBED_MODEL);
    expect(e.dimensions).toBe(LOCAL_EMBED_DIM);
    await expectUnitVec(e);
    expect(calls).toEqual(["https://hf-mirror.com"]);
    await e.embed("第二条");
    expect(calls).toHaveLength(1); // 模块级缓存：不重复加载
  });

  test("源失败自动换下一个（hf-mirror → huggingface.co）", async () => {
    reset();
    failHosts.add("https://hf-mirror.com");
    const e = createLocalEmbedder();
    await expectUnitVec(e);
    expect(calls).toEqual(["https://hf-mirror.com", "https://huggingface.co"]);
  });

  test("HF_ENDPOINT 显式指定时最优先，失败同样回退", async () => {
    reset();
    process.env.HF_ENDPOINT = "https://custom.example";
    failHosts.add("https://custom.example");
    try {
      const e = createLocalEmbedder();
      await expectUnitVec(e);
      expect(calls[0]).toBe("https://custom.example");
      expect(calls).toContain("https://hf-mirror.com");
    } finally {
      delete process.env.HF_ENDPOINT;
    }
  });

  test("全部源失败时 embed 抛错，且失败后能重试（单例已清）", async () => {
    reset();
    failHosts.add("https://hf-mirror.com");
    failHosts.add("https://huggingface.co");
    const e = createLocalEmbedder();
    await expect(e.embed("你好")).rejects.toThrow("boom");
    failHosts.clear();
    await expectUnitVec(e, "重试");
  });
});

describe("isTransformersMissing（v2.6.1 缺包识别）", () => {
  test("命中 Bun / Node 两种动态 import 缺包文案", () => {
    expect(
      isTransformersMissing(
        new Error("Cannot find package '@huggingface/transformers' from 'D:/x/local-embedder.ts'")
      )
    ).toBe(true);
    expect(
      isTransformersMissing(
        new Error("[ERR_MODULE_NOT_FOUND] Cannot find package '@huggingface/transformers' imported from /x/y.js")
      )
    ).toBe(true);
  });

  test("网络等其它错误不误判", () => {
    expect(isTransformersMissing(new Error("network down"))).toBe(false);
    expect(isTransformersMissing(new Error("Cannot find package 'other-pkg'"))).toBe(false);
    expect(isTransformersMissing("字符串错误")).toBe(false);
    expect(isTransformersMissing(null)).toBe(false);
  });
});
