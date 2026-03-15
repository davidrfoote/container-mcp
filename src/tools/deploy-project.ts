import { exec as execAsync } from 'child_process';
import { promisify } from 'util';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

const execPromise = promisify(execAsync);

// --- Deploy-agent HTTP API helper ---
// Calls the host-side deploy-agent service (http://172.17.0.1:18790) instead of running
// docker commands directly. This fixes phantom deploys when container-mcp runs inside
// a dev container that has no docker CLI.

async function callDeployAgent(projectId: string, sessionId?: string): Promise<DeployResult | null> {
  const deployAgentUrl = (process.env.DEPLOY_AGENT_URL || '').trim();
  const deployAgentToken = (process.env.DEPLOY_AGENT_TOKEN || '').trim();

  if (!deployAgentUrl) return null; // Not configured — fall back to legacy behavior

  const url = `${deployAgentUrl}/deploy`;
  const body = JSON.stringify({ project_id: projectId, session_id: sessionId ?? null });

  return new Promise((resolve) => {
    const isHttps = url.startsWith('https');
    const mod = isHttps ? https : http;
    const parsedUrl = new URL(url);

    const options: http.RequestOptions = {
      method: 'POST',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(deployAgentToken ? { 'Authorization': `Bearer ${deployAgentToken}` } : {}),
      },
      timeout: 300000,
    };

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as { ok: boolean; sha?: string; smoke_status?: number | null; output?: string; error?: string };
          resolve({
            success: parsed.ok ?? false,
            output: parsed.output ?? parsed.error ?? data,
            smoke_status: parsed.smoke_status != null ? String(parsed.smoke_status) : 'unknown',
          });
        } catch {
          resolve({ success: false, output: `deploy-agent parse error: ${data}`, smoke_status: 'error' });
        }
      });
    });

    req.on('error', (err: Error) => {
      console.error('[deploy_project] deploy-agent call failed:', err.message, '— falling back to local execution');
      resolve(null); // null = fall back
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, output: 'deploy-agent request timed out', smoke_status: 'timeout' });
    });

    req.write(body);
    req.end();
  });
}

// --- Types ---

interface ProjectRow {
  build_cmd: string | null;
  deploy_cmd: string | null;
  smoke_url: string | null;
  working_dir: string | null;
  default_container: string | null;
}

export interface DeployResult {
  success: boolean;
  output: string;
  smoke_status: string;
}

// --- DB helpers ---

async function withDeployClient<T>(dbUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function lookupProject(dbUrl: string, projectId: string): Promise<ProjectRow | null> {
  return withDeployClient(dbUrl, async (client) => {
    const result = await client.query<ProjectRow>(
      'SELECT build_cmd, deploy_cmd, smoke_url, working_dir, default_container FROM projects WHERE project_id = $1',
      [projectId]
    );
    return result.rows[0] ?? null;
  });
}

async function detectAndRegisterProject(dbUrl: string, projectId: string): Promise<ProjectRow> {
  const homeDir = process.env.AGENT_HOME_DIR ?? '/home/david';
  const candidateDirs = [
    `${homeDir}/${projectId}`,
    `/home/openclaw/apps/${projectId}`,
    `/opt/${projectId}`,
  ];

  let workingDir: string | null = null;
  for (const dir of candidateDirs) {
    if (fs.existsSync(dir)) {
      workingDir = dir;
      break;
    }
  }

  if (!workingDir) {
    throw new Error(
      `Cannot auto-detect: no directory found for project_id '${projectId}'. Tried: ${candidateDirs.join(', ')}`
    );
  }

  const hasSwarmYml = fs.existsSync(path.join(workingDir, 'swarm.yml'));
  const hasDockerfile = fs.existsSync(path.join(workingDir, 'Dockerfile'));
  const hasPkgJson = fs.existsSync(path.join(workingDir, 'package.json'));
  const hasRequirements = fs.existsSync(path.join(workingDir, 'requirements.txt'));
  const hasPyproject = fs.existsSync(path.join(workingDir, 'pyproject.toml'));

  let buildCmd: string;
  let deployCmd: string;
  const smokeUrl: string = '';

  if (hasSwarmYml) {
    buildCmd = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
    deployCmd = `docker stack deploy -c ${workingDir}/swarm.yml ${projectId}`;
  } else if (hasDockerfile) {
    buildCmd = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
    deployCmd = `docker service update --image ${projectId}:latest prod_${projectId} || docker service update --image ${projectId}:latest ${projectId}`;
  } else if (hasPkgJson) {
    let pkgJson: Record<string, unknown> = {};
    try {
      pkgJson = JSON.parse(fs.readFileSync(path.join(workingDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    } catch { /* ignore parse error */ }
    const deps = (pkgJson?.dependencies ?? {}) as Record<string, unknown>;
    const devDeps = (pkgJson?.devDependencies ?? {}) as Record<string, unknown>;
    const isNext = Boolean(deps.next ?? devDeps.next);
    if (isNext) {
      buildCmd = `cd ${workingDir} && docker build -t ${projectId}:latest .`;
      deployCmd = `docker service update --image ${projectId}:latest prod_${projectId} || docker service update --image ${projectId}:latest ${projectId}`;
    } else {
      buildCmd = `cd ${workingDir} && npm install && npm run build`;
      deployCmd = `pkill -f "node dist/index.js" 2>/dev/null || true; nohup node ${workingDir}/dist/index.js > /tmp/${projectId}.log 2>&1 &`;
    }
  } else if (hasRequirements || hasPyproject) {
    buildCmd = `cd ${workingDir} && pip install -r ${hasRequirements ? 'requirements.txt' : '.'} -q`;
    deployCmd = `pkill -f "${workingDir}/main.py" 2>/dev/null || true; nohup python3 ${workingDir}/main.py > /tmp/${projectId}.log 2>&1 &`;
  } else {
    throw new Error(
      `Cannot auto-detect deploy type for '${projectId}' in ${workingDir}. No swarm.yml, Dockerfile, package.json, or requirements.txt found.`
    );
  }

  await withDeployClient(dbUrl, async (client) => {
    await client.query(
      `INSERT INTO projects (project_id, build_cmd, deploy_cmd, smoke_url, working_dir, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (project_id) DO UPDATE SET
         build_cmd = EXCLUDED.build_cmd,
         deploy_cmd = EXCLUDED.deploy_cmd,
         smoke_url = EXCLUDED.smoke_url,
         working_dir = EXCLUDED.working_dir,
         updated_at = now()`,
      [projectId, buildCmd, deployCmd, smokeUrl || null, workingDir]
    );
  });

  return {
    build_cmd: buildCmd,
    deploy_cmd: deployCmd,
    smoke_url: smokeUrl || null,
    working_dir: workingDir,
    default_container: null,
  };
}

async function runInContainer(containerName: string, cmd: string): Promise<string> {
  const safeCmd = cmd.replace(/"/g, '\\"');
  const dockerCmd = `docker exec ${containerName} bash -c "${safeCmd}"`;
  const { stdout, stderr } = await execPromise(dockerCmd, { timeout: 300000 });
  return stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
}

async function runLocalCmd(cmd: string): Promise<string> {
  const { stdout, stderr } = await execPromise(cmd, { timeout: 300000 });
  return stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
}

function fetchUrl(url: string): Promise<{ status: number; ok: boolean }> {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) < 400 });
    });
    req.on('error', () => resolve({ status: 0, ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false }); });
  });
}

async function smokeTest(url: string): Promise<string> {
  if (!url || url.trim() === '' || url === 'null') return 'skipped';
  for (let i = 1; i <= 12; i++) {
    try {
      const result = await fetchUrl(url);
      if (result.ok) return `passed (HTTP ${result.status}, attempt ${i})`;
    } catch { /* retry */ }
    if (i < 12) await new Promise<void>(r => setTimeout(r, 5000));
  }
  return 'failed (12 attempts exhausted)';
}

async function postSessionMessage(dbUrl: string, sessionId: string, content: string, msgType: string = 'execution_update'): Promise<void> {
  if (!sessionId) return;
  const msgId = `msg-${Date.now()}-deploy`;
  try {
    await withDeployClient(dbUrl, async (client) => {
      await client.query(
        'INSERT INTO session_messages (message_id, session_id, role, content, message_type, created_at) VALUES ($1, $2, $3, $4, $5, now())',
        [msgId, sessionId, 'dev_lead', content, msgType]
      );
    });
  } catch (err) {
    console.error('[deploy_project] Failed to post session message:', err);
  }
}

// --- Main export ---

export async function deployProject(projectId: string, sessionId?: string): Promise<DeployResult> {
  const dbUrl = process.env.OPS_DB_URL;
  if (!dbUrl) {
    return { success: false, output: 'OPS_DB_URL not set', smoke_status: 'error' };
  }

  const output: string[] = [];

  try {
    // Look up project
    let project = await lookupProject(dbUrl, projectId);

    if (!project) {
      output.push(`[deploy_project] Project '${projectId}' not in projects table — auto-detecting...`);
      await postSessionMessage(dbUrl, sessionId ?? '', `🔍 Auto-detecting deploy type for '${projectId}'...`, 'console');
      project = await detectAndRegisterProject(dbUrl, projectId);
      output.push(`[deploy_project] Auto-detected and registered: build=${project.build_cmd}, deploy=${project.deploy_cmd}`);
      await postSessionMessage(dbUrl, sessionId ?? '', `✅ Auto-detected: ${project.deploy_cmd}`, 'console');
    }

    const { build_cmd, deploy_cmd, smoke_url, default_container } = project;
    const container = default_container ?? null;

    // --- Delegate to deploy-agent HTTP API (preferred — avoids docker CLI issues in containers) ---
    await postSessionMessage(dbUrl, sessionId ?? '', `🔧 Attempting deploy via deploy-agent HTTP API...`, 'console');
    const agentResult = await callDeployAgent(projectId, sessionId);
    if (agentResult !== null) {
      output.push(`[deploy_project] Delegated to deploy-agent HTTP API`);
      output.push(agentResult.output);
      const resultMsg = agentResult.success
        ? `✅ deploy_project('${projectId}') complete via deploy-agent. Smoke: ${agentResult.smoke_status}`
        : `❌ deploy_project('${projectId}') failed via deploy-agent. Smoke: ${agentResult.smoke_status}`;
      await postSessionMessage(dbUrl, sessionId ?? '', resultMsg, 'checkpoint');
      return { ...agentResult, output: output.join('\n') };
    }
    // deploy-agent not configured or returned null — fall through to legacy local execution
    await postSessionMessage(dbUrl, sessionId ?? '', `⚠️ deploy-agent not available — falling back to local execution`, 'console');

    // Build phase
    if (build_cmd) {
      output.push(`[deploy_project] Running build: ${build_cmd}`);
      await postSessionMessage(dbUrl, sessionId ?? '', `🔧 Build: ${build_cmd}`, 'execution_log');
      try {
        const buildOut = container
          ? await runInContainer(container, build_cmd)
          : await runLocalCmd(build_cmd);
        output.push(buildOut);
        await postSessionMessage(dbUrl, sessionId ?? '', `✅ Build complete`, 'execution_log');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        output.push(`BUILD FAILED: ${msg}`);
        await postSessionMessage(dbUrl, sessionId ?? '', `❌ Build failed: ${msg}`, 'execution_log');
        return { success: false, output: output.join('\n'), smoke_status: 'skipped' };
      }
    }

    // Deploy phase
    if (deploy_cmd) {
      output.push(`[deploy_project] Running deploy: ${deploy_cmd}`);
      await postSessionMessage(dbUrl, sessionId ?? '', `🚀 Deploy: ${deploy_cmd}`, 'execution_log');
      try {
        const deployOut = container
          ? await runInContainer(container, deploy_cmd)
          : await runLocalCmd(deploy_cmd);
        output.push(deployOut);
        await postSessionMessage(dbUrl, sessionId ?? '', `✅ Deploy complete`, 'execution_log');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        output.push(`DEPLOY FAILED: ${msg}`);
        await postSessionMessage(dbUrl, sessionId ?? '', `❌ Deploy failed: ${msg}`, 'execution_log');
        return { success: false, output: output.join('\n'), smoke_status: 'skipped' };
      }
    }

    // Smoke test phase
    await postSessionMessage(dbUrl, sessionId ?? '', `🔧 Smoke test → ${smoke_url || '(none)'}`, 'execution_log');
    const smokeStatus = await smokeTest(smoke_url ?? '');
    const smokeEmoji = smokeStatus.startsWith('passed') ? '✅' : smokeStatus === 'skipped' ? '⚠️' : '❌';
    await postSessionMessage(dbUrl, sessionId ?? '', `${smokeEmoji} Smoke: ${smokeStatus}`, 'execution_log');
    output.push(`[deploy_project] Smoke: ${smokeStatus}`);

    const success = smokeStatus === 'skipped' || smokeStatus.startsWith('passed');
    const resultMsg = success
      ? `✅ deploy_project('${projectId}') complete. Smoke: ${smokeStatus}`
      : `❌ deploy_project('${projectId}') failed smoke test. Smoke: ${smokeStatus}`;
    await postSessionMessage(dbUrl, sessionId ?? '', resultMsg, 'checkpoint');

    return { success, output: output.join('\n'), smoke_status: smokeStatus };

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await postSessionMessage(dbUrl, sessionId ?? '', `❌ deploy_project error: ${msg}`, 'execution_log').catch(() => {});
    return { success: false, output: `Error: ${msg}`, smoke_status: 'error' };
  }
}
