// null/empty string means administrator scope; an empty array denies all rows.
export function scopeSql(column, scope) {
  if (!scope) return { sql: "1=1", params: [] };
  const ids = Array.isArray(scope) ? scope : [scope];
  return {
    sql: ids.length ? `${column} IN (${ids.map(() => "?").join(",")})` : "0=1",
    params: ids,
  };
}
export function inScope(id, scope) {
  return !scope || (Array.isArray(scope) ? scope.includes(id) : scope === id);
}
