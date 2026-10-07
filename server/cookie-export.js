// Cookie-Editor imports the browser cookies API's JSON format.
export function cookieEditorCookies(cookies, now = Date.now() / 1000) {
  const sameSite = { Strict: "strict", Lax: "lax", None: "no_restriction" };
  return cookies
    .filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, "").toLowerCase();
      return (
        (domain === "douyin.com" || domain.endsWith(".douyin.com")) &&
        (cookie.expires <= 0 || cookie.expires > now)
      );
    })
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      hostOnly: !cookie.domain.startsWith("."),
      sameSite: sameSite[cookie.sameSite] || "unspecified",
      session: cookie.expires <= 0,
      ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
    }));
}
