import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { parse } from "yaml";
import { detectCycle } from "./scheduler.ts";
import type {
    MainCheckoutAction,
    MultreeConfig,
    RepoConfig,
    UpdateStrategy,
} from "./types.ts";

const HOME_CONFIG_PATH = join(homedir(), "multree.config.yaml");

export function loadConfig(): { config: MultreeConfig; path: string } {
    const path = resolveConfigPath();
    const config = parse(readFileSync(path, "utf-8")) as MultreeConfig;
    validate(config);
    return { config, path };
}

function resolveConfigPath(): string {
    if (process.env.MULTREE_CONFIG) {
        return resolve(process.env.MULTREE_CONFIG);
    }
    if (existsSync(HOME_CONFIG_PATH)) {
        return HOME_CONFIG_PATH;
    }
    throw new Error(
        `No multree manifest found. Either set $MULTREE_CONFIG, or copy ` +
            `multree.config.example.yaml from the repo to ${HOME_CONFIG_PATH} and edit.`,
    );
}

function validate(cfg: MultreeConfig): void {
    if (cfg.version !== 1) {
        throw new Error(`Unsupported config version: ${cfg.version} (expected 1)`);
    }
    if (!cfg.repos || Object.keys(cfg.repos).length === 0) {
        throw new Error("Config has no repos defined");
    }
    for (const [name, repo] of Object.entries(cfg.repos)) {
        if (!repo.path) {
            throw new Error(`Repo "${name}" is missing required field: path`);
        }
    }
    validateDependsOn(cfg);
}

function validateDependsOn(cfg: MultreeConfig): void {
    const known = Object.keys(cfg.repos);
    const depsOf: Record<string, string[]> = {};
    for (const [name, repo] of Object.entries(cfg.repos)) {
        if (!repo.depends_on) {
            continue;
        }
        for (const dep of repo.depends_on) {
            if (!cfg.repos[dep]) {
                throw new Error(`Repo "${name}" depends_on unknown repo "${dep}"`);
            }
            if (dep === name) {
                throw new Error(`Repo "${name}" depends_on itself`);
            }
        }
        depsOf[name] = repo.depends_on;
    }
    const cycle = detectCycle(known, depsOf);
    if (cycle) {
        throw new Error(`depends_on cycle: ${cycle.join(" -> ")}`);
    }
}

export function expandPath(p: string): string {
    if (p.startsWith("~/")) {
        return join(homedir(), p.slice(2));
    }
    return p;
}

export function resolveWorktreeRoot(cfg: MultreeConfig): string {
    return expandPath(cfg.worktree_root ?? "~/dev/worktree");
}

export function resolveBranchBase(repoCfg: { branch_base?: string }): string {
    return repoCfg.branch_base ?? "origin/main";
}

export function resolveUpdateStrategy(
    cfg: MultreeConfig,
    repoCfg: RepoConfig,
): UpdateStrategy {
    return repoCfg.update_strategy ?? cfg.update_strategy ?? "rebase";
}

export function canPush(repoCfg: RepoConfig): boolean {
    return repoCfg.push !== false;
}

export function resolveMainCheckoutAction(
    cfg: MultreeConfig,
    repoCfg: RepoConfig,
): MainCheckoutAction {
    return repoCfg.main_checkout_action ?? cfg.main_checkout_action ?? "switch";
}

// Local branch name implied by a `branch_base` like "origin/develop" or
// just "develop". Used as the default destination when we have to free a
// branch from the main checkout via "switch".
export function defaultBranchFromBase(repoCfg: RepoConfig): string {
    const base = repoCfg.branch_base ?? "origin/main";
    // Strip the leading remote name segment (everything up to and including
    // the first slash) if present, otherwise return as-is.
    const slash = base.indexOf("/");
    return slash === -1 ? base : base.slice(slash + 1);
}
