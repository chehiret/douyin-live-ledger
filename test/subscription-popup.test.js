import { test } from "node:test";
import assert from "node:assert/strict";
import { dismissSubscriptionPopup } from "../server/subscription-popup.js";

test("提示弹窗被遮挡或页面关闭：错误在处理器内捕获，不让后台退出", async () => {
  for (const name of ["TimeoutError", "TargetClosedError"]) {
    const messages = [];
    const popup = {
      getByRole(role, options) {
        assert.equal(role, "button");
        assert.deepEqual(options, { name: "close", exact: true });
        return {
          async click(options) {
            assert.equal(options.timeout, 2000);
            throw Object.assign(new Error("private-page-details"), { name });
          },
        };
      },
    };
    assert.equal(await dismissSubscriptionPopup(popup, (...args) => messages.push(args)), false);
    assert.equal(messages.length, 1);
    assert.equal(messages[0][1], name);
    assert.ok(!messages.flat().join(" ").includes("private-page-details"));
  }
});

test("成功关闭准确匹配的订阅提示后正常返回", async () => {
  let clicks = 0;
  const popup = { getByRole: () => ({ click: async options => { assert.equal(options.force, true); clicks++; } }) };
  assert.equal(await dismissSubscriptionPopup(popup, () => assert.fail("成功时无需告警")), true);
  assert.equal(clicks, 1);
});
