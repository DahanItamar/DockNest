// The deployment hold (scripts/deployment-preflight.js) pauses new work during an upgrade. One check for site jobs,
// self-backups and recovery kits. Takes the database so kit creation can also check its snapshot; imports nothing,
// so the standalone kit restore never opens live state.
export const deploymentHoldMessage='Deployment verification is in progress. Retry after it completes.';
export const deploymentHeld=database=>!!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()&&database.prepare("SELECT value FROM settings WHERE key='deployment_hold'").get()?.value==='true';
export function requireNoDeploymentHold(database){if(deploymentHeld(database))throw Object.assign(new Error(deploymentHoldMessage),{status:409});}
