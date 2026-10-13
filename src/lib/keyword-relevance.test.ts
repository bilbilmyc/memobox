import { test, expect } from "bun:test";
import { KeywordIndex } from "./memory";
import identifiers from "../../scripts/fixtures/retrieval-identifiers.json";

test("英语问题里的功能词不独立召回无关内容，否定词与仅功能词的精确检索保留", () => {
  const index = new KeywordIndex();
  index.rebuild([{ id: "port", content: "The configured port is 3100", createdAt: 1 }, { id: "privacy", content: "Do not upload secrets", createdAt: 2 },
    { id: "tag", content: "endpoint settings", entities: ["开发端口", "my-tools"], createdAt: 3 }]);
  expect(index.search("What is the cake recipe?", 5)).toEqual([]);
  expect(index.search("do not", 5)[0].id).toBe("privacy");
  expect(index.search("the", 5)[0].id).toBe("port");
  expect(index.search("端口", 5)[0].id).toBe("tag");
  expect(index.search("tools", 5)[0].id).toBe("tag");
  index.add({ id: "changed", content: "not related", entities: ["my-tools"], createdAt: 4 });
  expect(index.search("tools", 5)).toHaveLength(2);
  index.remove("tag"); expect(index.search("tools", 5).map(row => row.id)).toEqual(["changed"]);
});

test("技术标识符可用自然词和原串检索，正文与实体遵循同样的词边界", () => {
  const samples = [
    ["cache_invalidation", "cache invalidation"], ["requestTimeout", "request timeout"],
    ["HTTPServer", "http server"], ["retry-budget", "retry budget"], ["database.host", "database host"],
  ];
  for (const [identifier, query] of samples) {
    for (const entityOnly of [false, true]) {
      const index = new KeywordIndex();
      index.rebuild([{ id: "target", content: entityOnly ? "设置记录" : `${identifier} 已启用`, entities: entityOnly ? [identifier] : [], createdAt: 1 }]);
      expect(index.search(query, 5).map(row => row.id)).toEqual(["target"]);
      expect(index.search(identifier, 5).map(row => row.id)).toEqual(["target"]);
    }
  }
});

test("拉丁词内子串不构成正文或双向实体命中", () => {
  for (const [query, content] of [["go", "Django"], ["rust", "trust"], ["sql", "mysql"], ["bun", "bundle"], ["go", "𐐀go"], ["go", "go𐐀"]]) {
    const index = new KeywordIndex();
    index.rebuild([{ id: "body", content, createdAt: 1 }, { id: "entity", content: "设置记录", entities: [content], createdAt: 2 }]);
    expect(index.search(query, 5)).toEqual([]);
    index.rebuild([{ id: "reverse", content: "设置记录", entities: [query], createdAt: 1 }]);
    expect(index.search(content, 5)).toEqual([]);
  }
});

test("单字中文实体可作为长中文查询的入口", () => {
  const index = new KeywordIndex();
  index.rebuild([{ id: "cloud", content: "实例设置记录", entities: ["云"], createdAt: 1 }]);
  expect(index.search("云服务", 5).map(row => row.id)).toEqual(["cloud"]);
});

test("重复实体组成词与大量其他实体共存，删除一条不影响另一条", () => {
  const index = new KeywordIndex();
  index.rebuild(Array.from({ length: 150 }, (_, i) => ({ id: `other-${i}`, content: "无关配置", entities: [`item-${i}`], createdAt: i })));
  index.add({ id: "one", content: "设置记录", entities: ["HTTPServer", "http_server"], createdAt: 1 });
  index.add({ id: "two", content: "设置记录", entities: ["HTTPServer"], createdAt: 2 });
  expect(index.search("http server", 5).map(row => row.id)).toEqual(["two", "one"]);
  index.remove("one");
  expect(index.search("http server", 5).map(row => row.id)).toEqual(["two"]);
  index.add({ id: "two", content: "设置记录", entities: ["lease_duration"], createdAt: 2 });
  expect(index.search("http server", 5)).toEqual([]);
  expect(index.search("lease duration", 5).map(row => row.id)).toEqual(["two"]);
});

test("中文邻接、完整符号串和实体复数兼容，索引替换删除不留旧词", () => {
  const index = new KeywordIndex();
  index.rebuild([{ id: "target", content: "使用Go开发，版本 v2.6.3；符号 C++", entities: ["ports"], createdAt: 1 }]);
  for (const query of ["go", "v2.6.3", "C++", "port", "ports"]) expect(index.search(query, 5).map(row => row.id)).toEqual(["target"]);
  index.add({ id: "target", content: "requestTimeout = 5000", entities: ["cache_invalidation"], createdAt: 2 });
  expect(index.search("go", 5)).toEqual([]);
  expect(index.search("port", 5)).toEqual([]);
  expect(index.search("cache invalidation", 5)).toHaveLength(1);
  expect(index.search("request timeout", 5)).toHaveLength(1);
  index.remove("target");
  expect(index.search("request timeout", 5)).toEqual([]);
  expect(index.search("cache invalidation", 5)).toEqual([]);
});

for (const split of ["training", "heldout"] as const) test(`冻结标识符语料 ${split} 关键词行为回归`, () => {
  const index = new KeywordIndex();
  index.rebuild(identifiers.memories.filter(row => row.id.startsWith(split === "training" ? "t-" : "h-")));
  for (const item of identifiers[split]) {
    const ids = index.search(item.query, 5).map(row => row.id);
    if (!item.relevant.length) expect(ids).toEqual([]);
    else {
      for (const id of item.relevant) expect(ids).toContain(id);
      expect(item.relevant).toContain(ids[0]);
    }
  }
});
