import { readFile, rename, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { request, successful } from './http.mjs';
import { getToken, refuseProduction } from './token.mjs';

export async function run({
  env = process.env,
  args = process.argv.slice(2),
  execute,
  print = (text) => process.stdout.write(text),
} = {}) {
  const operation = args[0] ?? 'apply';
  if (!['apply', 'plan', 'token'].includes(operation))
    throw new Error('choose apply, plan or token');
  const environment = env.CALFLEX_ZITADEL_ENVIRONMENT ?? 'local';
  if (!['local', 'staging', 'production'].includes(environment))
    throw new Error('invalid environment');
  const issuer = env.CALFLEX_OIDC_ISSUER ?? 'https://auth.localhost:8443';
  // Refuse BEFORE reading a credential or state, initializing tofu or contacting an API.
  if (operation === 'token') refuseProduction(issuer, environment);
  if (!env.PG_CONN_STR)
    throw new Error(
      "PG_CONN_STR must point to this instance's Zitadel database",
    );
  const baseUrl = env.CALFLEX_ZITADEL_BASE_URL ?? issuer;
  const authority = new URL(issuer).host;
  const ca = env.CALFLEX_ZITADEL_CA_PATH
    ? await readFile(env.CALFLEX_ZITADEL_CA_PATH)
    : undefined;
  const tofuEnv = {
    ...env,
    TF_DATA_DIR:
      env.TF_DATA_DIR ?? `/tmp/calflex-tofu/${environment}/.terraform`,
  };
  // Reading an existing helper output needs no bootstrap account at all.
  if (operation !== 'token') {
    const pat =
      env.ZITADEL_ACCESS_TOKEN ??
      (
        await readFile(
          env.CALFLEX_SEED_PAT_PATH ?? '/zitadel-bootstrap/seed.pat',
          'utf8',
        )
      ).trim();
    const org = successful(
      await request(`${baseUrl}/management/v1/orgs/me`, {
        token: pat,
        ca,
        host: authority,
      }),
      'read bootstrap organization',
    );
    Object.assign(tofuEnv, {
      TF_VAR_environment: environment,
      TF_VAR_org_id: org.org.id,
      TF_VAR_domain:
        environment === 'local' ? 'zitadel-api' : new URL(issuer).hostname,
      TF_VAR_port:
        environment === 'local' ? '8080' : new URL(issuer).port || '443',
      TF_VAR_insecure: String(environment === 'local'),
      TF_VAR_authority: environment === 'local' ? authority : '',
      TF_VAR_access_token: pat,
    });
  }
  const call =
    execute ??
    ((argv, capture = false) => {
      const result = spawnSync('tofu', argv, {
        env: tofuEnv,
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      });
      if (result.error) throw new Error('could not start OpenTofu');
      if (result.status !== 0) {
        if (operation === 'plan' && result.status === 2) {
          process.exitCode = 2;
          return '';
        }
        // Captured output may include secrets, never echo it.
        throw new Error(`OpenTofu failed (exit ${result.status})`);
      }
      return result.stdout;
    });
  await call(
    ['init', '-input=false', '-lockfile=readonly'],
    operation === 'token',
  );
  if (operation !== 'token') {
    await call([
      operation,
      '-input=false',
      ...(operation === 'apply' ? ['-auto-approve'] : ['-detailed-exitcode']),
      `-var-file=environments/${environment}.tfvars`,
    ]);
    // The API validates `aud` against the project ID this apply created, and it
    // boots before the seed does, so `apply` publishes it into the shared
    // `oidc-config` volume. `plan` never writes: a dry run changes nothing.
    if (operation === 'apply' && env.CALFLEX_OIDC_AUDIENCE_OUT) {
      /** @type {Record<string, any>} */
      let outputs;
      try {
        outputs = JSON.parse(await call(['output', '-json'], true));
      } catch {
        throw new Error('cannot read OpenTofu outputs');
      }
      const projectId = outputs.project_id?.value;
      if (typeof projectId !== 'string' || projectId === '')
        throw new Error('no project id in this configuration');
      const target = env.CALFLEX_OIDC_AUDIENCE_OUT;
      const temporary = `${target}.${process.pid}.tmp`;
      // Atomic, mode 0644, and nothing else in the file: the API reads the
      // trimmed first line, lazily, and re-reads it after an audience mismatch.
      await writeFile(temporary, `${projectId}\n`, { mode: 0o644 });
      await rename(temporary, target);
    }
    return;
  }
  let outputs;
  try {
    outputs = JSON.parse(await call(['output', '-json'], true));
  } catch {
    throw new Error('cannot read OpenTofu outputs');
  }
  if (!outputs.token_helper_pat?.value)
    throw new Error('no token-helper account in this configuration');
  const user = env.CALFLEX_TOKEN_USER;
  if (!user) throw new Error('make token requires USER=<seeded user>');
  const token = await getToken({
    environment,
    issuer,
    baseUrl,
    ca,
    user,
    projectId: outputs.project_id.value,
    clientId: outputs.android_client_id.value,
    pat: outputs.token_helper_pat.value,
    password: env.CALFLEX_SEED_PASSWORD ?? 'Development1!',
  });
  print(`${token}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((error) => {
    process.stderr.write(`zitadel: ${error.message}\n`);
    process.exitCode = 1;
  });
}
