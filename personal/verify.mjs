import { resolve } from 'node:path';
import { runVerification, repositoryRoot } from './upgrade.mjs';
import { cleanRevision, recordInstallable } from './artifact.mjs';
try {
  const root = process.argv[2] ? resolve(process.argv[2]) : repositoryRoot;
  const commit = await cleanRevision(root);
  const stages = await runVerification(root, stage => console.log(`VERIFY ${stage}`));
  console.log(JSON.stringify(await recordInstallable(root, stages, commit), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
