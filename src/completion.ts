// Pure completion logic + the bash/zsh wrapper scripts. No filesystem or shell
// side effects live here: `computeCandidates` is a function of an explicit
// `CompletionContext` so it can be unit-tested without a manifest on disk. The
// orchestrator in `commands/completion.ts` builds the context (reading config,
// state and profiles, failure-soft) and prints the result.

export interface CompletionGroup {
    name: string;
    members: string[];
}

export interface CompletionContext {
    // Canonical built-in subcommand names, completable at the first position.
    commands: string[];
    // Manifest tool names — also valid first-position subcommands.
    tools: string[];
    // Repo keys from the manifest.
    repos: string[];
    // Existing groups with their member repo keys.
    groups: CompletionGroup[];
    // Profile names (yaml files + alias names) under MULTREE_HOME.
    profiles: string[];
}

// Canonical built-in subcommands. Single source of truth for both the completer
// and cli.ts's BUILTIN_COMMANDS set (which adds the --help/-h/--version/-v flag
// aliases on top of these). Keeping this list here — in a side-effect-free
// module — lets cli.ts derive from it without importing the executing entry.
export const SUBCOMMANDS = [
    "create",
    "add",
    "remove",
    "list",
    "show",
    "status",
    "update",
    "push",
    "rewire",
    "destroy",
    "profile",
    "shell",
    "completion",
    "help",
] as const;

type ValueKind = "strategy" | "repos" | "members" | "free";

interface FlagSpec {
    // Value-taking flags map to a completion kind; boolean flags omit `value`.
    value?: ValueKind;
}

// Per-subcommand long flags. `--profile` is global and appended everywhere via
// flagNames(). `--from-<repo>` is dynamic (per-repo) and handled specially.
const COMMAND_FLAGS: Record<string, Record<string, FlagSpec>> = {
    create: {
        "--include": { value: "repos" },
        "--branch": { value: "free" },
        "--from": { value: "free" },
        "--jobs": { value: "free" },
        "--plan": {},
        "--resume": {},
        "--verbose": {},
    },
    add: { "--verbose": {} },
    status: { "--fetch": {} },
    update: { "--strategy": { value: "strategy" } },
    push: {
        "--include": { value: "members" },
        "--set-upstream": {},
        "--force": {},
    },
};

// Subcommands whose first positional is an existing group name. Tool names
// (dynamic) behave the same way and are handled alongside these.
const GROUP_FIRST = new Set([
    "show",
    "status",
    "update",
    "push",
    "rewire",
    "destroy",
    "remove",
    "add",
    "shell",
]);

function filterByPrefix(items: string[], cur: string): string[] {
    return items.filter(item => item.startsWith(cur));
}

function groupNames(ctx: CompletionContext): string[] {
    return ctx.groups.map(g => g.name);
}

function membersOf(ctx: CompletionContext, name: string | undefined): string[] {
    if (!name) {
        return [];
    }
    return ctx.groups.find(g => g.name === name)?.members ?? [];
}

// `--profile` is consumed by the global pre-pass and handled before we get here;
// `--from-<repo>` is a dynamic per-repo override taking a free-text branch.
function flagValueKind(subcommand: string, flag: string): ValueKind | undefined {
    if (flag.startsWith("--from-")) {
        return "free";
    }
    return COMMAND_FLAGS[subcommand]?.[flag]?.value;
}

function flagNames(subcommand: string): string[] {
    return [...Object.keys(COMMAND_FLAGS[subcommand] ?? {}), "--profile"];
}

// Strip a leading `--profile <value>` global-flag pair so we land on the real
// subcommand. Returns undefined when the cursor is still at the subcommand slot.
function splitSubcommand(before: string[]): { subcommand: string | undefined; rest: string[] } {
    let i = 0;
    while (i < before.length && before[i] === "--profile") {
        i += 2;
    }
    return { subcommand: before[i], rest: before.slice(i + 1) };
}

// Tokens after the subcommand that are positionals (skipping flags and the
// values that value-taking flags consume).
function collectPositionals(subcommand: string, rest: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        if (t.startsWith("-")) {
            if (flagValueKind(subcommand, t) !== undefined) {
                i++; // skip this flag's value
            }
            continue;
        }
        out.push(t);
    }
    return out;
}

// Comma-separated value completion (e.g. `--include api,frontend`). Splits on
// the final comma: everything up to it is preserved verbatim, the tail is the
// prefix to match, and already-chosen items are filtered out. Each candidate is
// the full replacement for the current word, so the shell swaps it in wholesale.
function completeCsv(pool: string[], cur: string): string[] {
    const lastComma = cur.lastIndexOf(",");
    const head = lastComma === -1 ? "" : cur.slice(0, lastComma + 1);
    const tail = lastComma === -1 ? cur : cur.slice(lastComma + 1);
    const chosen = new Set(head.split(",").map(s => s.trim()).filter(Boolean));
    return pool
        .filter(item => !chosen.has(item) && item.startsWith(tail))
        .map(item => head + item);
}

function completeFlagValue(
    kind: ValueKind,
    rest: string[],
    cur: string,
    ctx: CompletionContext,
): string[] {
    switch (kind) {
        case "strategy":
            return filterByPrefix(["rebase", "merge"], cur);
        case "free":
            return [];
        case "repos":
            return completeCsv(ctx.repos, cur);
        case "members":
            // `push --include` scopes to members of the already-named group.
            return completeCsv(membersOf(ctx, collectPositionals("push", rest)[0]), cur);
    }
}

function completeProfilePositional(
    positionals: string[],
    cur: string,
    ctx: CompletionContext,
): string[] {
    const idx = positionals.length;
    if (idx === 0) {
        return filterByPrefix(["list", "path", "alias", "unalias"], cur);
    }
    const action = positionals[0];
    if (idx === 1 && (action === "path" || action === "alias" || action === "unalias")) {
        return filterByPrefix(ctx.profiles, cur);
    }
    if (idx === 2 && action === "alias") {
        return filterByPrefix(ctx.profiles, cur);
    }
    return [];
}

function completePositional(
    subcommand: string,
    isTool: boolean,
    positionals: string[],
    cur: string,
    ctx: CompletionContext,
): string[] {
    if (subcommand === "profile") {
        return completeProfilePositional(positionals, cur, ctx);
    }
    if (subcommand === "completion") {
        return positionals.length === 0 ? filterByPrefix(["bash", "zsh"], cur) : [];
    }
    if (isTool || GROUP_FIRST.has(subcommand)) {
        const idx = positionals.length;
        if (idx === 0) {
            return filterByPrefix(groupNames(ctx), cur);
        }
        if (idx === 1) {
            if (subcommand === "remove" || subcommand === "shell") {
                return filterByPrefix(membersOf(ctx, positionals[0]), cur);
            }
            if (subcommand === "add") {
                // Only offer repos not already in the group.
                const present = new Set(membersOf(ctx, positionals[0]));
                return filterByPrefix(ctx.repos.filter(r => !present.has(r)), cur);
            }
        }
        return [];
    }
    // `create`'s first positional is a new (free-text) group name; `list`/`help`
    // take none.
    return [];
}

// Given the in-progress command-line words (excluding the program name, with the
// last element being the word under the cursor — possibly empty), return the
// complete replacement candidates for that last word, filtered to match it.
export function computeCandidates(ctx: CompletionContext, rawWords: string[]): string[] {
    const words = rawWords.length === 0 ? [""] : rawWords;
    const cur = words[words.length - 1];
    const before = words.slice(0, -1);
    const prev = before.length > 0 ? before[before.length - 1] : undefined;

    // Global `--profile <value>`, wherever it appears on the line.
    if (prev === "--profile") {
        return filterByPrefix(ctx.profiles, cur);
    }

    const { subcommand, rest } = splitSubcommand(before);

    // First position: the subcommand itself (or global flags).
    if (subcommand === undefined) {
        if (cur.startsWith("-")) {
            return filterByPrefix(["--help", "--version", "--profile"], cur);
        }
        return filterByPrefix([...new Set([...ctx.commands, ...ctx.tools])], cur);
    }

    const isTool = ctx.tools.includes(subcommand);

    // Value completion for the preceding value-taking flag.
    if (prev !== undefined && prev.startsWith("--")) {
        const kind = flagValueKind(subcommand, prev);
        if (kind) {
            return completeFlagValue(kind, rest, cur, ctx);
        }
    }

    // Flags when the current word opens with a dash.
    if (cur.startsWith("-")) {
        return filterByPrefix(flagNames(subcommand), cur);
    }

    return completePositional(subcommand, isTool, collectPositionals(subcommand, rest), cur, ctx);
}

// Wrapper scripts. Both pass the words up to and including the (possibly empty)
// word under the cursor to `multree __complete`, then feed the newline-separated
// candidates back to the shell. The program is invoked as the user typed it
// (COMP_WORDS[0] / words[1]) so a non-PATH invocation still self-dispatches.
export const BASH_COMPLETION = `# multree bash completion — eval "$(multree completion bash)"
_multree_complete() {
    # COMPREPLY=( $(...) ) with IFS=newline rather than mapfile/readarray: the
    # latter is bash 4.0+, but macOS still ships the system bash 3.2. Group/repo
    # names are restricted to [A-Za-z0-9._-] so unquoted word-splitting here is
    # safe (no glob/space surprises).
    local cur args IFS=$'\\n'
    cur="\${COMP_WORDS[COMP_CWORD]}"
    args=("\${COMP_WORDS[@]:1:COMP_CWORD-1}" "\$cur")
    COMPREPLY=($("\${COMP_WORDS[0]}" __complete "\${args[@]}" 2>/dev/null))
}
complete -F _multree_complete multree
`;

export const ZSH_COMPLETION = `# multree zsh completion — eval "$(multree completion zsh)"
_multree_complete() {
    local cur
    cur="\${words[CURRENT]}"
    local -a pre cands
    pre=("\${(@)words[2,CURRENT-1]}")
    cands=("\${(@f)$(\${words[1]} __complete "\${pre[@]}" "\$cur" 2>/dev/null)}")
    cands=(\${cands:#})
    compadd -a cands
}
compdef _multree_complete multree
`;
