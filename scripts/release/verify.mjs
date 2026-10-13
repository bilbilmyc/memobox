import assert from "node:assert/strict";
import { readRegistry } from "./plan.mjs";

/** 发布只执行一次；后续只读查询等待 registry 的各个视图一致。 */
export async function verifyPublishedRelease({ version, integrity }, {
  fetchFn = fetch,
  wait = (ms) => new Promise(done => setTimeout(done, ms)),
  attempts = 60,
  delayMs = 2000,
} = {}) {
  let pending = "版本尚不可见";
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetchFn(`https://registry.npmjs.org/memobox/${version}`, { signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const released = await response.json();
      assert.equal(released.dist.integrity, integrity, "Published tarball integrity mismatch");
      if (released.dist.attestations?.url) {
        const current = await readRegistry(fetchFn);
        if (current.latest === version) return;
        pending = "latest 仍为 " + (current.latest ?? "未设置");
      } else pending = "来源证明尚不可见";
    } else {
      if (response.status !== 404 && response.status !== 429 && response.status < 500)
        throw Error("发布后查询失败：HTTP " + response.status);
      pending = "版本查询 HTTP " + response.status;
    }
    if (attempt + 1 < attempts) await wait(delayMs);
  }
  throw Error("npm publish 已成功，但 registry 验证超时（" + pending + "）；请查询版本，勿重复发布同版本");
}
