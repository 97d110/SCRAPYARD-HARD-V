/**
 * Billing killswitch.
 *
 * Subscribed to the budget's Pub/Sub topic. When reported spend exceeds the
 * budget, this detaches the billing account from the project, which halts
 * everything chargeable.
 *
 * ── This is destructive ─────────────────────────────────────────────────────
 * Detaching billing stops the VM, and Google eventually deletes the persistent
 * disk. It protects the wallet by destroying the deployment. Keep backups; see
 * infra/README.md.
 *
 * Google's budget notifications are best-effort and can lag by hours, so treat
 * this as a backstop against runaway spend, not as a precise spending cap.
 */
const { CloudBillingClient } = require('@google-cloud/billing');

const billing = new CloudBillingClient();

exports.stopBilling = async (event) => {
  const raw = event?.data
    ? Buffer.from(event.data, 'base64').toString('utf8')
    : '{}';

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    console.error('Unparseable budget notification, ignoring:', raw);
    return;
  }

  const cost = Number(payload.costAmount ?? 0);
  const budget = Number(payload.budgetAmount ?? 0);
  const label = payload.budgetDisplayName ?? 'unnamed budget';

  // Budget notifications fire on every threshold, including ones we don't care
  // about, so most invocations should land here and do nothing.
  if (!Number.isFinite(cost) || !Number.isFinite(budget) || cost <= budget) {
    console.log(`[${label}] cost ${cost} <= budget ${budget} — no action.`);
    return;
  }

  const projectId = process.env.TARGET_PROJECT_ID;
  if (!projectId) {
    console.error('TARGET_PROJECT_ID is unset; refusing to guess which project to disable.');
    return;
  }

  const name = `projects/${projectId}`;
  const [info] = await billing.getProjectBillingInfo({ name });

  if (!info.billingAccountName) {
    console.log(`[${label}] billing is already detached from ${name}.`);
    return;
  }

  // Empty billingAccountName is the documented way to detach.
  await billing.updateProjectBillingInfo({
    name,
    projectBillingInfo: { billingAccountName: '' },
  });

  console.error(
    `[${label}] KILLSWITCH FIRED — billing detached from ${name}. ` +
      `Reported cost ${cost} exceeded budget ${budget}. ` +
      `The VM is now stopped and the disk will eventually be deleted.`,
  );
};
