const MESSAGE_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

/** Preserve wire integers before JSON.parse can round uint64 message IDs. */
export function parseWeixinApiJson<T>(source: string): T {
  const strings = /"(?:\\[\s\S]|[^"\\])*"/g;
  const parts: string[] = [];
  let copied = 0;
  for (let token = strings.exec(source); token; token = strings.exec(source)) {
    let cursor = strings.lastIndex;
    while (/\s/.test(source[cursor] ?? "")) cursor++;
    if (source[cursor] !== ":" || !MESSAGE_ID_FIELDS.has(JSON.parse(token[0]) as string)) continue;
    cursor++;
    while (/\s/.test(source[cursor] ?? "")) cursor++;
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(cursor))?.[0];
    if (!number) continue;
    const end = cursor + number.length;
    // Leave invalid JSON intact so the parser rejects it (e.g. leading zeroes).
    if (source[end] && !/[\s,}\]]/.test(source[end])) continue;
    if (!/^\d+$/.test(number)) throw new SyntaxError("Weixin message ID must be an unsigned integer");
    parts.push(source.slice(copied, cursor), JSON.stringify(number));
    copied = end;
  }
  parts.push(source.slice(copied));
  return JSON.parse(parts.join("")) as T;
}

/** Numeric values are accepted only for legacy callers that have not lost precision. */
export function weixinMessageId(value: string | number | undefined): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
}
