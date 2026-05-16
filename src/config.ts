import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { parse } from "yaml";
import type { MultreeConfig } from "./types.ts";

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
}

export function expandPath(p: string): string {
    if (p.startsWith("~/")) {
        return join(homedir(), p.slice(2));
    }
    return p;
}

export function resolveBranchBase(repoCfg: { branch_base?: string }): string {
    return repoCfg.branch_base ?? "origin/main";
}
