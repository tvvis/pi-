import type { Theme } from "@earendil-works/pi-coding-agent";

interface HighlightRule {
  pattern: RegExp;
  style: (text: string, theme: Theme) => string;
}

// ─── Filename type detection ──────────────────────────────────────────────

/**
 * Color a filename by its extension/type.
 * Mirrors the per-extension coloring used for `ls -l` output.
 */
function styleByExt(name: string, theme: Theme): string {
  // Archives — red
  if (/\.(?:zip|tar(?:\.gz)?|tgz|tbz2?|tbz|7z|rar|gz|bz2|xz|jar|war|ear|apk|ipa|deb|rpm|msi|dmg|iso|img|whl|egg)$/i.test(name)) {
    return theme.fg("error", name);
  }
  // Scripts — green
  if (/\.(?:sh|bash|zsh|py|pl|rb|lua|fish|ksh|ps1|bat|cmd|psm1)$/i.test(name)) {
    return theme.fg("success", name);
  }
  // Media — magenta (syntaxString)
  if (/\.(?:png|jpe?g|gif|bmp|svg|ico|webp|tiff?|psd|ai|mp[34]|wav|flac|ogg|webm|mkv|mov|avi|wmv|flv)$/i.test(name)) {
    return theme.fg("syntaxString", name);
  }
  // Source code — purple (syntaxKeyword)
  if (/\.(?:tsx?|jsx?|c|cpp|cc|cxx|h|hpp|java|go|rs|swift|m|mm|kt|scala|clj|ex|exs|erl|hs|fs|fsx|sql|graphql|proto|scss|sass|less|html|vue|svelte)$/i.test(name)) {
    return theme.fg("syntaxKeyword", name);
  }
  // Config / data — blue
  if (/\.(?:conf|cfg|ini|ya?ml|toml|json|xml|env|properties|csv|tsv|nix|lock|gradle|sbt|pom)$/i.test(name)) {
    return theme.fg("accent", name);
  }
  // Text / logs — dim
  if (/\.(?:log|out|err|trace|txt|md|markdown|rst|adoc|tex)$/i.test(name)) {
    return theme.fg("dim", name);
  }
  // Libraries / objects — blue (accent)
  if (/\.(?:so|dll|dylib|o|a|lib|obj)$/i.test(name)) {
    return theme.fg("accent", name);
  }
  // Documents — blue
  if (/\.(?:pdf|docx?|odt|rtf|epub|mobi)$/i.test(name)) {
    return theme.fg("accent", name);
  }
  // Special names — blue
  if (/^(?:Dockerfile|dockerfile|Makefile|makefile|CMakeLists\.txt|Rakefile|Vagrantfile|Procfile|README|readme|LICENSE|license|CONTRIBUTING|CHANGELOG|AUTHORS|TODO)$/i.test(name)) {
    return theme.fg("accent", name);
  }
  return name;
}

// ─── ls -l structured output ──────────────────────────────────────────────

type LsTypeColor = "accent" | "syntaxString" | "muted" | "dim" | "text";

const LS_TYPE_COLOR: Record<string, LsTypeColor> = {
  d: "accent",        // directory
  l: "syntaxString",  // symlink
  c: "muted",         // char device
  b: "muted",         // block device
  p: "muted",         // named pipe
  s: "muted",         // socket
  "-": "dim",         // regular file
};

const LS_TOTAL_RE = /^total\s+(\d+)\s*$/;

// Standard `ls -l` line: perms(10) nlink user group size month day time|year name
// Size may include units (e.g. "5.0K", "1.2M") and old files show year instead of time.
const LS_L_RE = /^([-dlsbcp])([rwx-]{9})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s+(.+?)\s*$/;

/**
 * Color a single line of `ls -l` style output with per-field colors.
 * Returns null if the line doesn't match the format.
 */
function highlightLsLine(line: string, theme: Theme): string | null {
  const total = LS_TOTAL_RE.exec(line);
  if (total) {
    return theme.fg("dim", `total ${total[1]}`);
  }

  const m = LS_L_RE.exec(line);
  if (!m) return null;

  const [, typeChar, perm, nlink, user, group, size, month, day, time, name] = m;
  const typeColor = LS_TYPE_COLOR[typeChar] ?? "text";

  // Symlink name may include " -> target"; color only the link, dim the target.
  let nameOut: string;
  let suffix = "";
  const arrow = name.indexOf(" -> ");
  if (arrow >= 0) {
    nameOut = styleByExt(name.slice(0, arrow), theme);
    suffix = theme.fg("dim", name.slice(arrow));
  } else {
    nameOut = styleByExt(name, theme);
  }

  return [
    theme.fg(typeColor, typeChar),
    theme.fg("muted", perm),
    " ",
    theme.fg("syntaxKeyword", nlink),
    " ",
    theme.fg("muted", user),
    " ",
    theme.fg("muted", group),
    " ",
    theme.fg("syntaxKeyword", size),
    " ",
    theme.fg("accent", month),
    " ",
    theme.fg("accent", day),
    " ",
    theme.fg("success", time),
    " ",
    nameOut,
    suffix,
  ].join("");
}

// ─── Generic keyword/pattern rules ────────────────────────────────────────

// Build a single alternation of file extensions for bare-filename highlighting.
const FILE_EXT_ALT = [
  // archives
  "zip|tar(?:\\.gz)?|tgz|tbz2?|tbz|7z|rar|gz|bz2|xz|jar|war|ear|apk|ipa|deb|rpm|dmg|iso|img|whl|egg",
  // scripts
  "sh|bash|zsh|py|pl|rb|lua|fish|ksh|ps1|bat|cmd",
  // media
  "png|jpe?g|gif|bmp|svg|ico|webp|tiff?|mp[34]|wav|flac|ogg|webm|mkv|mov|avi",
  // source
  "tsx?|jsx?|c|cpp|cc|cxx|h|hpp|java|go|rs|swift|m|mm|sql|scss|sass|less|html|vue|svelte",
  // config
  "json|ya?ml|toml|conf|cfg|ini|xml|env|properties|csv|tsv",
  // text / docs
  "log|txt|md|pdf",
  // libraries
  "so|dll|dylib|o|a|lib",
].join("|");

const RULES: HighlightRule[] = [
  // Errors — keep word stems without trailing \b so suffixes match too
  { pattern: /error|fail(?:ed|ure)?|fatal|abort(?:ed|ing)?|denied|deny|refused|refuse|invalid|cannot|not found|no such/gi,
    style: (t, th) => th.fg("error", t) },
  // Warnings
  { pattern: /warn(?:ing)?|deprecated|notice/gi,
    style: (t, th) => th.fg("accent", t) },
  // Success
  { pattern: /\b(?:ok|done|ready|complet(?:e|ed)|success|pass(?:ed)?|active|running|enabled|started)\b/gi,
    style: (t, th) => th.fg("success", t) },
  // Paths — color dynamically by file extension
  { pattern: /(?:\/[^\s,:;()\[\]{}]+)+(?:\/[^\s,:;()\[\]{}]*)?/g,
    style: (t, th) => {
      if (/\.(?:conf|cfg|ini|yaml|yml|toml|json)$/i.test(t)) return th.fg("accent", t);
      if (/\.(?:sh|bash|zsh)$/i.test(t)) return th.fg("success", t);
      if (/(?:\/log(?:\/|$)|\.(?:log|txt)$)/i.test(t)) return th.fg("dim", t);
      if (/\.(?:service|timer|socket|target|mount|automount|path|slice|scope)$/i.test(t)) return th.fg("accent", t);
      return th.fg("accent", t);
    } },
  // Bare filenames with a recognizable extension — colored by type
  { pattern: new RegExp(`\\b[\\w][\\w.+\\-]*\\.(?:${FILE_EXT_ALT})\\b`, "gi"),
    style: (t, th) => styleByExt(t, th) },
  // IP addresses
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    style: (t, th) => th.fg("accent", t) },
  // Numbers with word-unit suffixes (KB, MB, ms, etc.)
  { pattern: /\b\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB|ms|s|m|h)\b/gi,
    style: (t, th) => th.fg("accent", t) },
  // Numbers with non-word suffixes (%, etc.) — no \b after suffix
  { pattern: /\b\d+(?:\.\d+)?%/g,
    style: (t, th) => th.fg("accent", t) },
  // Timestamps — restrictive HH:MM(:SS(.mmm)?) — must run before IPv6
  { pattern: /\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?\b/g,
    style: (t, th) => th.fg("dim", t) },
  // IPv6 addresses — after timestamps; matches 2+ colon-separated hex groups
  { pattern: /(?:[\da-f]{0,4}:){2,}[\da-f]{0,4}(?:\/[\d]{1,3})?/gi,
    style: (t, th) => th.fg("accent", t) },
];

/**
 * Highlight a single line of remote output.
 *
 * First tries structured `ls -l` formatting (per-field colors), then
 * falls back to keyword/pattern rules for arbitrary output.
 */
export function highlightLine(line: string, theme: Theme): string {
  // Quick check: if no recognizable patterns, return plain
  if (!line || !/[a-zA-Z0-9/]/.test(line)) return line;

  // Try structured ls -l formatting first
  const ls = highlightLsLine(line, theme);
  if (ls !== null) return ls;

  const matches: Array<{ start: number; end: number; style: (t: string, th: Theme) => string }> = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(line)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, style: rule.style });
    }
  }

  if (matches.length === 0) return line;

  // Sort by start position, longest match first for ties
  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  // Build output, skipping overlapping matches
  const parts: string[] = [];
  let pos = 0;
  for (const m of matches) {
    if (m.start < pos) continue; // skip overlaps
    if (m.start > pos) parts.push(line.slice(pos, m.start));
    parts.push(m.style(line.slice(m.start, m.end), theme));
    pos = m.end;
  }
  parts.push(line.slice(pos));

  return parts.join("");
}
