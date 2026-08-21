/**
 * Per-provider command restrictions for the bash tool.
 *
 * Some providers restrict which commands the model can run. Restrictions are
 * evaluated against the raw command string before execution. The matcher is
 * intentionally permissive: it splits on common shell operators so that piped,
 * chained, and subshell commands are all inspected. It does NOT simulate shell
 * expansion; runtime tricks like variable indirection or alias expansion can
 * still bypass these checks. That trade-off is acceptable because the goal is
 * to prevent casual misuse, not to harden a hostile process.
 */

/** Providers whose models have restricted command sets. Add entries here. */
export const RESTRICTED_PROVIDERS = new Set<string>(["minimax-cn"]);

/**
 * Subcommands of `git` that restricted providers may still invoke.
 *
 * The list is intentionally curated rather than deny-by-default-inverted:
 * anything that mutates the working tree, index, refs, or remote state
 * (push, pull, fetch, add, reset, checkout, rebase, merge, cherry-pick,
 * revert, stash, clean, etc.) is excluded even if the subcommand string
 * itself is short. `commit` is the one explicit write exception; `branch`
 * and `tag` are listed for inspection but their mutating flags are
 * rejected separately (see `hasGitWriteFlag`).
 */
const GIT_ALLOWED_SUBCOMMANDS = new Set([
	// user-approved local writes
	"add",
	"commit",
	// read-only inspection
	"branch",
	"cat-file",
	"describe",
	"diff",
	"diff-files",
	"diff-index",
	"diff-tree",
	"format-patch",
	"grep",
	"help",
	"log",
	"ls-files",
	"ls-remote",
	"ls-tree",
	"reflog",
	"remote",
	"rev-list",
	"rev-parse",
	"shortlog",
	"show",
	"show-branch",
	"status",
	"tag",
	"version",
	"whatchanged",
]);

/** Flags that turn an otherwise read-only `git branch`/`git tag` into a mutation. */
const GIT_WRITE_FLAGS = new Set([
	"-d",
	"-D",
	"--delete",
	"-m",
	"-M",
	"--move",
	"-c",
	"-C",
	"--copy",
	"-f",
	"--force",
	"--unset-upstream",
]);

function hasGitWriteFlag(tokens: string[]): boolean {
	for (const raw of tokens.slice(2)) {
		const tok = stripQuotes(raw);
		if (GIT_WRITE_FLAGS.has(tok)) return true;
		if (
			tok.startsWith("--") &&
			(tok.startsWith("--delete") || tok.startsWith("--move") || tok.startsWith("--force"))
		) {
			return true;
		}
	}
	return false;
}

export interface CommandRestrictionViolation {
	/** Short reason describing why the command was blocked. */
	reason: string;
}

/**
 * Evaluate whether `command` violates any provider-specific restrictions.
 *
 * Returns the first violation found, or `undefined` when the command is
 * allowed. Returns `undefined` for unknown providers (no restrictions).
 */
export function checkCommandRestrictions(
	command: string,
	provider: string | undefined,
): CommandRestrictionViolation | undefined {
	if (!provider || !RESTRICTED_PROVIDERS.has(provider)) {
		return undefined;
	}
	for (const segment of splitCommandSegments(command)) {
		const trimmed = segment.trim();
		if (!trimmed) continue;
		const tokens = tokenize(trimmed);
		if (tokens.length === 0) continue;
		const head = stripQuotes(tokens[0]);

		if (head === "rm" || head === "/bin/rm" || head === "/usr/bin/rm") {
			const violation = findRmRfViolation(tokens);
			if (violation) return violation;
			continue;
		}

		if (head === "git" || head === "/usr/bin/git" || head === "/usr/local/bin/git") {
			const sub = tokens.length > 1 ? stripQuotes(tokens[1]) : undefined;
			if (!sub || !GIT_ALLOWED_SUBCOMMANDS.has(sub)) {
				return {
					reason: sub
						? `git ${sub} is not allowed for provider '${provider}'; only read-only git subcommands are permitted`
						: `git is not allowed for provider '${provider}'; only read-only git subcommands are permitted`,
				};
			}
			// branch and tag are listed above because their default form is
			// read-only (list branches/tags), but a destructive flag turns them
			// into a mutation. Block that explicitly.
			if ((sub === "branch" || sub === "tag") && hasGitWriteFlag(tokens)) {
				return {
					reason: `git ${sub} with mutating flags is not allowed for provider '${provider}'`,
				};
			}
		}
	}
	return undefined;
}

/**
 * Split a command string into top-level segments separated by common shell
 * operators. Quoted spans are kept intact so that an `rm -rf` inside a quoted
 * string is still seen by the tokenizer. Contents of `$(...)` and backticks
 * are also surfaced as their own segments.
 */
function splitCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let buf = "";
	let i = 0;
	const len = command.length;
	let quote: string | undefined;
	while (i < len) {
		const ch = command[i];
		if (quote) {
			buf += ch;
			if (ch === "\\" && i + 1 < len) {
				buf += command[i + 1];
				i += 2;
				continue;
			}
			if (ch === quote) quote = undefined;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			buf += ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < len) {
			buf += ch + command[i + 1];
			i += 2;
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			// Push the current buffer as its own segment, then recurse into the
			// subshell body until the matching `)` closes it.
			segments.push(buf);
			buf = "";
			i += 2;
			const bodyStart = i;
			let depth = 1;
			while (i < len && depth > 0) {
				const inner = command[i];
				if (inner === "(") depth++;
				else if (inner === ")") depth--;
				if (depth === 0) break;
				i++;
			}
			segments.push(...splitCommandSegments(command.slice(bodyStart, i)));
			if (i < len) i++; // skip the closing `)`
			continue;
		}
		if (ch === "`") {
			// Backtick command substitution: split body into its own segment tree.
			segments.push(buf);
			buf = "";
			i++;
			const bodyStart = i;
			while (i < len && command[i] !== "`") i++;
			segments.push(...splitCommandSegments(command.slice(bodyStart, i)));
			if (i < len) i++; // skip closing backtick
			continue;
		}
		// Detect `&&` and `||` before their single-char forms so the boundary is
		// consumed in one step.
		if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
			segments.push(buf);
			buf = "";
			i += 2;
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
			segments.push(buf);
			buf = "";
			i++;
			continue;
		}
		buf += ch;
		i++;
	}
	if (buf.length > 0) segments.push(buf);
	return segments;
}

/**
 * Tokenize a single command segment. Honors single and double quotes so that
 * `rm -rf 'foo bar'` is parsed as three tokens rather than four.
 */
function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let buf = "";
	let i = 0;
	const len = segment.length;
	let quote: string | undefined;
	while (i < len) {
		const ch = segment[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < len) {
				buf += ch + segment[i + 1];
				i += 2;
				continue;
			}
			buf += ch;
			if (ch === quote) quote = undefined;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < len) {
			buf += ch + segment[i + 1];
			i += 2;
			continue;
		}
		if (/\s/.test(ch)) {
			if (buf.length > 0) {
				tokens.push(buf);
				buf = "";
			}
			i++;
			continue;
		}
		buf += ch;
		i++;
	}
	if (buf.length > 0) tokens.push(buf);
	return tokens;
}

function stripQuotes(token: string): string {
	if (token.length >= 2) {
		const first = token[0];
		const last = token[token.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return token.slice(1, -1);
		}
	}
	return token;
}

/**
 * Detect `rm` invocations that combine recursive (`-r`/`-R`) and force (`-f`)
 * flags. Matches short-flag clusters like `-rf`, `-fr`, `-Rf`, `-fR`, and any
 * other ordering such as `-vrf` or `-rfv`.
 */
function findRmRfViolation(tokens: string[]): CommandRestrictionViolation | undefined {
	for (const raw of tokens.slice(1)) {
		const tok = stripQuotes(raw);
		if (!tok.startsWith("-")) continue;
		// Reject long flags like `--recursive --force` early: they are still
		// destructive, but the request only forbids `-rf`. Allow them through.
		if (tok.startsWith("--")) continue;
		const letters = tok.slice(1).replace(/[^a-zA-Z]/g, "");
		if (!letters) continue;
		const hasRecursive = /[rR]/.test(letters);
		const hasForce = /[fF]/.test(letters);
		if (hasRecursive && hasForce) {
			return { reason: `rm with recursive and force flags (${tok}) is not allowed for this provider` };
		}
	}
	return undefined;
}
