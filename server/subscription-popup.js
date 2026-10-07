// The tooltip can sit behind another overlay. A rejected locator handler must
// stay within this optional dismissal rather than terminate the server process.
export async function dismissSubscriptionPopup(subscription, warn = console.warn) {
  try {
    await subscription
      .getByRole("button", { name: "close", exact: true })
      .click({ timeout: 2000, force: true });
    return true;
  } catch (error) {
    warn("订阅提示关闭未完成，当前采集将按正常超时处理：", error.name || "Error");
    return false;
  }
}
