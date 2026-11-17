#!/usr/bin/env node
// jarvis-meeting CLI — operational tooling for a teammate deployment.
//
//   jarvis-meeting setup    scaffold a teammate SOUL + .env.local template
//   jarvis-meeting doctor   run preflight checks (PASS/WARN/FAIL); exits nonzero on FAIL
//   jarvis-meeting reindex  trigger a folder-backend reindex (openbrain = live no-op)
//
// ESM, node built-ins only (node:readline/promises for interactive prompts).

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { PersonaMode } from '../soul/schema.js';
import { scaffoldSoul, type SetupOptions } from './setup.js';
import { buildDoctorChecks, doctorEnvFromProcess } from './doctor.js';
import { runChecks, exitCodeFor, formatReport } from './checks.js';
import { buildConnectorChecks, type ConnectorCheckOptions } from './connector-check.js';
import { cmdOnboard } from './onboard.js';
import { reindex } from './reindex.js';

/** Parse `--key value` and `--flag` (boolean) pairs out of argv. */
function parseArgs(argv: string[]): { flags: Record<string, string>; bools: Set<string> } {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined || !a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      bools.add(key);
    }
  }
  return { flags, bools };
}

function isPersona(v: string | undefined): v is PersonaMode {
  return v === 'ai' || v === 'first_person';
}

async function cmdSetup(argv: string[]): Promise<number> {
  const { flags, bools } = parseArgs(argv);
  const nonInteractive = bools.has('non-interactive');
  const soulDir = flags['soul-dir'] ?? `${process.cwd()}/soul`;
  const projectDir = process.cwd();

  let teammate = flags['teammate'] ?? '';
  let name = flags['name'];
  let persona: PersonaMode | undefined = isPersona(flags['persona']) ? flags['persona'] : undefined;
  let endpoint = flags['endpoint'];

  if (!nonInteractive) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      if (teammate === '') teammate = (await rl.question('Teammate slug: ')).trim();
      if (name === undefined) {
        const a = (await rl.question(`Display name [${teammate}]: `)).trim();
        if (a !== '') name = a;
      }
      if (persona === undefined) {
        const a = (await rl.question('Persona (ai | first_person) [first_person]: ')).trim();
        if (isPersona(a)) persona = a;
      }
      if (endpoint === undefined) {
        const a = (await rl.question('Knowledge /search endpoint (optional): ')).trim();
        if (a !== '') endpoint = a;
      }
    } finally {
      rl.close();
    }
  }

  if (teammate.trim() === '') {
    console.error('setup: --teammate is required (or run interactively)');
    return 1;
  }

  const opts: SetupOptions = {
    teammate: teammate.trim(),
    soulDir,
    projectDir,
    force: bools.has('force'),
    ...(name !== undefined ? { name } : {}),
    ...(persona !== undefined ? { persona } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
  };

  try {
    const result = scaffoldSoul(opts);
    console.log(`Wrote SOUL: ${result.soulFile}`);
    console.log(result.envWritten ? `Wrote env template: ${result.envFile}` : `Env template exists: ${result.envFile} (left untouched)`);
    console.log('\nNext steps:');
    for (const step of result.nextSteps) console.log(`  ${step}`);
    return 0;
  } catch (err) {
    console.error(`setup failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function cmdDoctor(argv: string[]): Promise<number> {
  const { flags, bools } = parseArgs(argv);

  // Connector conformance mode: validate any second-brain /search+/store endpoint
  // against the contract (docs/CONNECTOR.md) instead of a teammate deployment.
  const connector = flags['connector'];
  if (connector !== undefined && connector.trim() !== '') {
    const opts: ConnectorCheckOptions = { store: !bools.has('no-store') };
    if (flags['query'] !== undefined) opts.query = flags['query'];
    if (flags['k'] !== undefined) {
      const k = parseInt(flags['k'], 10);
      if (Number.isFinite(k) && k > 0) opts.k = k;
    }
    const results = await runChecks(buildConnectorChecks(connector.trim(), opts));
    console.log(formatReport(results));
    return exitCodeFor(results);
  }

  const env = doctorEnvFromProcess();
  const teammate = flags['teammate'] ?? process.env['DEFAULT_TEAMMATE'] ?? 'example';
  const results = await runChecks(buildDoctorChecks(env, teammate));
  console.log(formatReport(results));
  return exitCodeFor(results);
}

async function cmdReindex(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const teammate = flags['teammate'] ?? process.env['DEFAULT_TEAMMATE'] ?? 'example';
  const soulDir = flags['soul-dir'] ?? process.env['SOUL_DIR'] ?? `${process.cwd()}/soul`;
  const result = await reindex(teammate, soulDir);
  console.log(result.message);
  return result.ok ? 0 : 1;
}

/** Start the local pilot stack (connector + service + ngrok) via scripts/up.sh. */
function cmdUp(argv: string[]): Promise<number> {
  // dirname is src/cli (tsx) or dist/cli (built); scripts/ is two levels up.
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'up.sh');
  return new Promise((resolve) => {
    const child = spawn('bash', [script, ...argv], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`up: failed to start (${err instanceof Error ? err.message : String(err)})`);
      resolve(1);
    });
  });
}

function usage(): void {
  console.log(
    [
      'jarvis-meeting <command>',
      '',
      'Commands:',
      '  onboard  guided fresh setup: env preflight, brain detect/build, interview -> SOUL + .env.local',
      '  setup    [--teammate <slug>] [--name <n>] [--persona ai|first_person] [--endpoint <url>] [--non-interactive] [--force]',
      '  doctor   [--teammate <slug>] | --connector <url> [--no-store] [--query <q>] [--k <n>]',
      '  up       start the local pilot stack (connector + service + ngrok) via scripts/up.sh',
      '  reindex  [--teammate <slug>]',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  const command = process.argv[2];
  const rest = process.argv.slice(3);
  switch (command) {
    case 'onboard':
      return cmdOnboard(rest);
    case 'setup':
      return cmdSetup(rest);
    case 'doctor':
      return cmdDoctor(rest);
    case 'up':
      return cmdUp(rest);
    case 'reindex':
      return cmdReindex(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      usage();
      return 0;
    default:
      console.error(`unknown command: ${command}`);
      usage();
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`jarvis-meeting: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  });
