import { test, expect } from "bun:test";
import { KeywordIndex } from "./memory";

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
