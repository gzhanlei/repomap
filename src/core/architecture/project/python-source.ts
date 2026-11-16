/** Keep original line numbers while removing numbered views, comments and triple-quoted strings. */
export function pythonCodeLines(content: string) {
  let triple: "\"\"\"" | "'''" | undefined;
  return content.split("\n").map((numberedLine) => {
    const line = numberedLine.replace(/^\s*\d+:\s?/, "");
    let output = "";
    for (let index = 0; index < line.length; index += 1) {
      if (triple) {
        if (line.startsWith(triple, index)) {
          triple = undefined;
          index += 2;
        }
        continue;
      }
      if (line[index] === "#") break;
      if (line.startsWith("\"\"\"", index)) {
        triple = "\"\"\"";
        index += 2;
        continue;
      }
      if (line.startsWith("'''", index)) {
        triple = "'''";
        index += 2;
        continue;
      }
      output += line[index];
    }
    return output;
  });
}

export function pythonMainGuardLine(content: string) {
  return pythonCodeLines(content).findIndex((line) => /^if\s+__name__\s*==\s*["']__main__["']\s*:/.test(line));
}

/**
 * Text for Python driver detection: string literals are stripped so prose and
 * data values ("MySQL Crowbar") cannot fake a second driver, but driver
 * connection URLs keep their scheme because the URL string is the declaration.
 */
export function pythonDriverMentionText(content: string) {
  return pythonCodeLines(content).join("\n").replace(/(["'])((?:\\.|(?!\1)[^\\])*)\1/g, (match, _quote: string, body: string) => {
    const scheme = body.match(/\b(?:mysql|postgres(?:ql)?|sqlite)(?:\+\w+)?:\/\//);
    return scheme ? ` ${scheme[0]} ` : " '' ";
  }).toLowerCase();
}
