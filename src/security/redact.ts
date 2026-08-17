const privateKeyLabel = String.raw`(?:[A-Z0-9][A-Z0-9 -]* )?PRIVATE KEY`;
const privateKeyHeaderPattern = new RegExp(
  String.raw`-----BEGIN ${privateKeyLabel}-----`,
  "giu",
);
const privateKeyBlockPattern = new RegExp(
  String.raw`-----BEGIN (${privateKeyLabel})-----[\s\S]*?-----END \1-----`,
  "giu",
);
const privateKeyLinePattern = new RegExp(
  String.raw`-----BEGIN ${privateKeyLabel}-----[^\r\n]*`,
  "giu",
);

const knownSecretPatterns: RegExp[] = [
  privateKeyHeaderPattern,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
  /\bnpm_[A-Za-z0-9]{30,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gu,
  /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
];

const keyName = String.raw`(?:api[_-]?key|apiKey|client[_-]?secret|clientSecret|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|auth[_-]?token|authToken|aws[_-]?secret[_-]?access[_-]?key|private[_-]?key|privateKey|secret|token|password|passwd|(?:[A-Za-z0-9]+[_-])+(?:secret|token|password|passwd|api[_-]?key|private[_-]?key))`;
const assignmentPattern = new RegExp(
  String.raw`(^|[^A-Za-z0-9_])((?:["']?${keyName}["']?)\s*[:=]\s*)(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|([^\s,;}]+))`,
  "gimu",
);
const credentialUrlPattern = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu;
const likelyCredentialUrlPattern =
  /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/:@]+:[^\s/@]+|[A-Za-z0-9_-]{16,})@/giu;

const placeholderValues = new Set([
  "changeme",
  "change-me",
  "change_me",
  "dummy",
  "example",
  "fake",
  "masked",
  "none",
  "not-a-secret",
  "null",
  "password",
  "redacted",
  "sample",
  "secret",
  "test",
  "testing",
  "token",
  "undefined",
]);

function isObviouslySynthetic(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    /(?:example|not.?a.?secret|dummy|fake|sample)/u.test(lower) ||
    /1234567890.*abcdefghijklmnop|abcdefghijklmnop.*1234567890/u.test(lower)
  );
}

function hasKnownSecret(value: string): boolean {
  return knownSecretPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    const found = [...value.matchAll(pattern)].some(
      (match) => match[0] !== undefined && !isObviouslySynthetic(match[0]),
    );
    pattern.lastIndex = 0;
    return found;
  });
}

function isReferenceOrPlaceholder(value: string): boolean {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  if (placeholderValues.has(lower)) return true;
  if (/^(?:your|example|sample|dummy|fake|test)[_-]/iu.test(normalized))
    return true;
  if (/^\[(?:redacted|masked)\]$/iu.test(normalized)) return true;
  if (/^<[^>]+>$/u.test(normalized)) return true;
  if (/^[x*._-]{8,}$/iu.test(normalized)) return true;
  if (/^(.)\1{7,}$/u.test(normalized)) return true;
  if (/^[~^<>=*v]?\d+(?:\.\d+)*(?:[-+][A-Za-z0-9.-]+)?$/u.test(normalized)) {
    return true;
  }
  if (
    /^[A-Za-z][A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key)$/iu.test(
      normalized,
    )
  ) {
    return true;
  }
  return /^(?:process\.env\.|import\.meta\.env\.|Deno\.env\.|Deno\.env\.get\s*\(|os\.(?:environ|getenv)|System\.getenv\s*\(|env(?:\.|\[|:\/\/)|config\.|settings\.|secrets?\.|getenv\s*\(|vault(?::\/\/|\.)|keyvault(?::\/\/|\.)|aws-secretsmanager:|sm:\/\/|file:\/\/|\$\{|\{\{|<%|%[A-Z0-9_]+%$)/iu.test(
    normalized,
  );
}

function hasLikelyAssignment(value: string): boolean {
  assignmentPattern.lastIndex = 0;
  for (const match of value.matchAll(assignmentPattern)) {
    const candidate = (match[3] ?? match[4] ?? match[5] ?? "").trim();
    const quoted = match[3] !== undefined || match[4] !== undefined;
    if (hasKnownSecret(candidate)) return true;
    if (
      candidate.length < 8 ||
      isObviouslySynthetic(candidate) ||
      isReferenceOrPlaceholder(candidate)
    )
      continue;
    if (quoted) return true;
    if (/[([{]/u.test(candidate)) continue;
    if (
      /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:\([^)]*\))?$/u.test(
        candidate,
      )
    ) {
      continue;
    }
    const hasLetter = /[A-Za-z]/u.test(candidate);
    const hasNonLetter = /[^A-Za-z]/u.test(candidate);
    if (candidate.length >= 12 && hasLetter && hasNonLetter) return true;
  }
  return false;
}

export function hasLikelySecret(value: string): boolean {
  likelyCredentialUrlPattern.lastIndex = 0;
  const hasCredentialUrl = likelyCredentialUrlPattern.test(value);
  likelyCredentialUrlPattern.lastIndex = 0;
  return (
    hasCredentialUrl || hasKnownSecret(value) || hasLikelyAssignment(value)
  );
}

export function redactSecrets(value: string): string {
  let safe = value.replace(credentialUrlPattern, "$1[REDACTED]@");
  privateKeyBlockPattern.lastIndex = 0;
  safe = safe.replace(privateKeyBlockPattern, "[REDACTED]");
  privateKeyLinePattern.lastIndex = 0;
  safe = safe.replace(privateKeyLinePattern, "[REDACTED]");
  for (const pattern of knownSecretPatterns) {
    pattern.lastIndex = 0;
    safe = safe.replace(pattern, "[REDACTED]");
  }
  assignmentPattern.lastIndex = 0;
  safe = safe.replace(
    assignmentPattern,
    (
      _match,
      leading: string,
      assignment: string,
      doubleQuoted?: string,
      singleQuoted?: string,
    ) => {
      const quote =
        doubleQuoted === undefined
          ? singleQuoted === undefined
            ? ""
            : "'"
          : '"';
      return `${leading}${assignment}${quote}[REDACTED]${quote}`;
    },
  );
  return safe;
}

export function safeEvidence(value: string, maximumLength = 160): string {
  const normalized = redactSecrets(value).trim().replaceAll(/\s+/gu, " ");
  if (normalized.length <= maximumLength) return normalized;
  return `${normalized.slice(0, maximumLength - 1)}…`;
}

export function safeTextFragment(value: string): string {
  let safe = "";
  for (const character of redactSecrets(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (!(
      (codePoint >= 0 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159)
    )) {
      safe += character;
    } else if (character === "\n") safe += "\\n";
    else if (character === "\r") safe += "\\r";
    else if (character === "\t") safe += "\\t";
    else safe += `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }
  return safe;
}
