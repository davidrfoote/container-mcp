import * as fs from "fs";
import * as path from "path";
import { withDbClient } from "../db.js";
import { populateCacheForProject } from "../jira-confluence.js";
import { deployProject } from "./deploy-project.js";
import type { ToolDefinition, McpToolResult } from "./git-tools.js";

export const projectToolDefinitions: ToolDefinition[] = [
  {
    name: "create_project",
    description: "Register a new project in the projects table (or update an existing one). Sets display name, description, build command, working directory, default container, Jira keys, Confluence root, and smoke URL. Auto-detects build command from the filesystem if not provided. Note: deploy_cmd is deprecated — deployment is handled by the CLI agent via deploy_project.",
    policy_class: "mutating",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Unique project identifier (e.g. 'my-api', 'ash-dashboard'). Used as PK in projects table.",
        },
        display_name: {
          type: "string",
          description: "Human-readable project name (e.g. 'Ash Dashboard')",
        },
        description: {
          type: "string",
          description: "Brief project description/context",
        },
        working_dir: {
          type: "string",
          description: "Absolute path to the project directory (e.g. /home/david/my-api). Auto-detected if omitted.",
        },
        default_container: {
          type: "string",
          description: "Default dev container name (e.g. 'dev-david')",
        },
        build_cmd: {
          type: "string",
          description: "Build command. Auto-detected from filesystem if omitted.",
        },
        smoke_url: {
          type: "string",
          description: "Health-check URL to verify deployment (e.g. https://app.example.com/health)",
        },
        jira_issue_keys: {
          type: "string",
          description: "Comma-separated parent Jira issue keys (e.g. 'ZI-18820,ZI-18821')",
        },
        confluence_root_id: {
          type: "string",
          description: "Confluence page ID for project documentation root",
        },
      },
      required: ["project_id"],
    },
  },
  {
    name: "deploy_project",
    description: "Deploy a project by ID. Spawns a CLI agent (Sonnet) that inspects topology files, builds, deploys, and smoke-tests the project. Returns immediately with a task ID; smoke_status is 'pending' until the agent posts a checkpoint to the session feed.",
    policy_class: "privileged",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Project ID (matches projects table project_id)",
        },
        session_id: {
          type: "string",
          description: "Optional session ID to post progress messages to",
        },
      },
      required: ["project_id"],
    },
  },
  {
    name: "warm_cache_for_repos",
    description: "Pre-populate project_context_cache for one or more repos by fetching their Jira issues and Confluence root page from the projects table",
    policy_class: "mutating",
    inputSchema: {
      type: "object",
      properties: {
        repos: {
          type: "array",
          items: { type: "string" },
          description: "List of project_id values from the projects table. Defaults to all three if omitted.",
        },
      },
      required: [],
    },
  },
];

export async function handleProjectTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  switch (name) {
    case "create_project": {
      const {
        project_id: projectId,
        display_name,
        description: projDescription,
        working_dir: inputWorkingDir,
        default_container,
        build_cmd: inputBuildCmd,
        smoke_url: inputSmokeUrl,
        jira_issue_keys: jiraKeysStr,
        confluence_root_id,
      } = args as {
        project_id: string;
        display_name?: string;
        description?: string;
        working_dir?: string;
        default_container?: string;
        build_cmd?: string;
        smoke_url?: string;
        jira_issue_keys?: string;
        confluence_root_id?: string;
      };

      const dbUrl = process.env.OPS_DB_URL;
      if (!dbUrl) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
      }

      let workingDir: string | null = inputWorkingDir || null;
      if (!workingDir) {
        for (const candidate of [`/home/david/${projectId}`, `/home/openclaw/apps/${projectId}`, `/opt/${projectId}`]) {
          if (fs.existsSync(candidate)) { workingDir = candidate; break; }
        }
      }

      let buildCmd: string | null = inputBuildCmd || null;
      const deployCmd: string | null = null; // deprecated — deploy_project uses CLI agent topology detection
      if (workingDir && !buildCmd) {
        const hasSwarmYml = fs.existsSync(path.join(workingDir, 'swarm.yml'));
        const hasDockerfile = fs.existsSync(path.join(workingDir, 'Dockerfile'));
        const hasPkgJson = fs.existsSync(path.join(workingDir, 'package.json'));
        const hasRequirements = fs.existsSync(path.join(workingDir, 'requirements.txt'));
        const hasPyproject = fs.existsSync(path.join(workingDir, 'pyproject.toml'));

        let detectedBuild: string | null = null;
        if (hasSwarmYml || hasDockerfile) {
          detectedBuild = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
        } else if (hasPkgJson) {
          detectedBuild = `cd ${workingDir} && npm install && npm run build`;
        } else if (hasRequirements || hasPyproject) {
          detectedBuild = `cd ${workingDir} && pip install -r ${hasRequirements ? 'requirements.txt' : '.'} -q`;
        }
        buildCmd = detectedBuild;
      }

      const jiraKeysArr = jiraKeysStr
        ? `{${jiraKeysStr.split(",").map((k: string) => k.trim()).filter(Boolean).join(",")}}`
        : null;

      try {
        await withDbClient(dbUrl, async (client) => {
          await client.query(
            `INSERT INTO projects (project_id, display_name, description, working_dir, default_container, build_cmd, deploy_cmd, smoke_url, jira_issue_keys, confluence_root_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, now(), now())
             ON CONFLICT (project_id) DO UPDATE SET
               display_name = COALESCE(EXCLUDED.display_name, projects.display_name),
               description = COALESCE(EXCLUDED.description, projects.description),
               working_dir = COALESCE(EXCLUDED.working_dir, projects.working_dir),
               default_container = COALESCE(EXCLUDED.default_container, projects.default_container),
               build_cmd = COALESCE(EXCLUDED.build_cmd, projects.build_cmd),
               deploy_cmd = COALESCE(EXCLUDED.deploy_cmd, projects.deploy_cmd),
               smoke_url = COALESCE(EXCLUDED.smoke_url, projects.smoke_url),
               jira_issue_keys = COALESCE(EXCLUDED.jira_issue_keys, projects.jira_issue_keys),
               confluence_root_id = COALESCE(EXCLUDED.confluence_root_id, projects.confluence_root_id),
               updated_at = now()`,
            [projectId, display_name || null, projDescription || null, workingDir, default_container || null, buildCmd, deployCmd, inputSmokeUrl || null, jiraKeysArr, confluence_root_id || null]
          );
        });

        const row = await withDbClient(dbUrl, async (client) => {
          const r = await client.query(
            `SELECT project_id, display_name, description, working_dir, default_container, build_cmd, deploy_cmd, smoke_url, jira_issue_keys, confluence_root_id, created_at, updated_at FROM projects WHERE project_id = $1`,
            [projectId]
          );
          return r.rows[0] ?? null;
        });

        return { content: [{ type: "text", text: JSON.stringify({ ok: true, project: row }) }] };
      } catch (err: unknown) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: (err as Error).message }) }], isError: true };
      }
    }

    case "deploy_project": {
      const { project_id, session_id: deploySessionId } = args as { project_id: string; session_id?: string };
      const result = await deployProject(project_id, deploySessionId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    case "warm_cache_for_repos": {
      const { repos: targetRepos } = args as { repos?: string[] };
      const repoList: string[] = Array.isArray(targetRepos) && targetRepos.length > 0
        ? targetRepos
        : ["dev-session-app", "container-mcp", "ash-dashboard"];
      const dbUrl = process.env.OPS_DB_URL;
      if (!dbUrl) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "OPS_DB_URL not set" }) }] };
      }
      const results: Record<string, string> = {};
      for (const repoId of repoList) {
        try {
          const projRow = await withDbClient(dbUrl, async (client) => {
            const r = await client.query<{
              confluence_root_id: string | null;
            }>(
              `SELECT confluence_root_id FROM projects WHERE project_id = $1`,
              [repoId]
            );
            return r.rows[0] ?? null;
          });
          if (!projRow) {
            results[repoId] = "not found in projects table";
            continue;
          }
          const confluenceRootId = projRow.confluence_root_id ?? null;
          await populateCacheForProject(dbUrl, [], confluenceRootId);
          results[repoId] = `ok (confluence: ${confluenceRootId ?? "none"})`;
        } catch (e: unknown) {
          results[repoId] = `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, results }) }] };
    }

    default:
      return { content: [{ type: "text", text: `Unknown project tool: ${name}` }], isError: true };
  }
}
