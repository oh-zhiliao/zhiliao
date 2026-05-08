import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("agent environment profile documentation", () => {
  it("documents per-environment agent profiles under ~/.config/zhiliao", () => {
    const claude = readRepoFile("CLAUDE.md");
    const deployment = readRepoFile("docs/deployment.md");

    expect(claude).toContain("~/.config/zhiliao/test.env");
    expect(claude).toContain("~/.config/zhiliao/prod.env");
    expect(deployment).toContain("~/.config/zhiliao/test.env");
    expect(deployment).toContain("~/.config/zhiliao/prod.env");
  });

  it("keeps Docker and deploy scripts independent from agent profile files", () => {
    const deploy = readRepoFile("deploy.sh");
    const deployLocal = readRepoFile("deploy-local.sh");
    const compose = readRepoFile("docker-compose.yml");
    const setup = readRepoFile("setup.sh");

    expect(deploy).not.toContain(".config/zhiliao");
    expect(deployLocal).not.toContain(".config/zhiliao");
    expect(setup).not.toContain(".config/zhiliao");
    expect(compose).not.toContain("env_file:");
    expect(compose).not.toContain("ZHILIAO_ENV_FILE");
  });

  it("documents deployment env as deployment-directory state", () => {
    const deployment = readRepoFile("docs/deployment.md");
    const claude = readRepoFile("CLAUDE.md");

    expect(deployment).toContain("Deployment runtime env stays in the deployment directory");
    expect(deployment).toContain("Deployment-local `.env`");
    expect(claude).toContain("部署运行时 `.env` 留在部署目录");
    expect(claude).not.toContain("~/.config/zhiliao/.env");
  });

  it("marks legacy deployment.md runbooks as replaced by environment profiles", () => {
    const claude = readRepoFile("CLAUDE.md");

    expect(claude).toContain("不要再维护 repo root 的 `deployment.md`");
    expect(claude).toContain("旧 `deployment.md` 的内容应拆分进对应环境 profile");
  });
});
