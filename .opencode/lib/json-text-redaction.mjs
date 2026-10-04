/**
 * Validate JSON and redact selected token spans without materializing numbers or
 * objects. Unchanged whitespace, duplicate keys, escapes and number literals
 * remain byte-for-byte identical. Invalid JSON throws SyntaxError.
 */
export function redactJsonText(text, { sensitiveKey = () => false, redactString = value => value, replaceSensitive = () => "[REDACTED]" } = {}) {
  if (typeof text !== "string") throw new TypeError("JSON text must be a string");
  let cursor = 0;
  const edits = [], stack = [{ kind: "root", state: "value", suppressed: false }];
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const fail = () => { throw new SyntaxError(`Invalid JSON at position ${cursor}`); };
  const whitespace = () => { while (cursor < text.length && /[\x20\t\r\n]/.test(text[cursor])) cursor += 1; };
  const string = () => {
    const start = cursor;
    if (text[cursor++] !== '"') fail();
    while (cursor < text.length) {
      if (text[cursor] === "\\") { cursor += 2; continue; }
      if (text[cursor++] === '"') return { start, value: JSON.parse(text.slice(start, cursor)) };
    }
    fail();
  };
  const replace = (start, value) => {
    if (typeof value !== "string") throw new TypeError("JSON redaction callbacks must return strings");
    edits.push({ start, end: cursor, value: JSON.stringify(value) });
  };
  const close = frame => {
    cursor += 1;
    stack.pop();
    if (frame.replace) replace(frame.start, replaceSensitive(frame.key));
  };
  while (stack.length) {
    whitespace();
    const frame = stack.at(-1), char = text[cursor];
    if (frame.state === "done") {
      if (cursor !== text.length) fail();
      stack.pop(); continue;
    }
    if (frame.state === "keyOrEnd" || frame.state === "key") {
      if (char === "}" && frame.state === "keyOrEnd") { close(frame); continue; }
      if (char !== '"') fail();
      frame.key = string().value;
      frame.state = "colon"; continue;
    }
    if (frame.state === "colon") {
      if (char !== ":") fail();
      cursor += 1; frame.state = "value"; continue;
    }
    if (frame.state === "commaOrEnd") {
      if (char === (frame.kind === "object" ? "}" : "]")) { close(frame); continue; }
      if (char !== ",") fail();
      cursor += 1; frame.state = frame.kind === "object" ? "key" : "value"; continue;
    }
    if (frame.state === "valueOrEnd" && char === "]") { close(frame); continue; }
    if (frame.state !== "value" && frame.state !== "valueOrEnd") fail();
    const start = cursor;
    const sensitive = frame.kind === "object" && !frame.suppressed && sensitiveKey(frame.key);
    const suppressed = frame.suppressed || sensitive;
    frame.state = frame.kind === "root" ? "done" : "commaOrEnd";
    if (char === "{" || char === "[") {
      cursor += 1;
      stack.push({ kind: char === "{" ? "object" : "array", state: char === "{" ? "keyOrEnd" : "valueOrEnd", suppressed,
        replace: sensitive, key: frame.key, start });
      continue;
    }
    if (char === '"') {
      const token = string();
      if (sensitive) replace(start, replaceSensitive(frame.key));
      else if (!suppressed) {
        const value = redactString(token.value);
        if (typeof value !== "string") throw new TypeError("JSON redaction callbacks must return strings");
        if (value !== token.value) replace(start, value);
      }
      continue;
    }
    const literal = ["true", "false", "null"].find(value => text.startsWith(value, cursor));
    if (literal) cursor += literal.length;
    else {
      number.lastIndex = cursor;
      const token = number.exec(text);
      if (!token) fail();
      cursor = number.lastIndex;
    }
    if (sensitive) replace(start, replaceSensitive(frame.key));
  }
  let result = "", offset = 0;
  for (const edit of edits) { result += text.slice(offset, edit.start) + edit.value; offset = edit.end; }
  return result + text.slice(offset);
}
