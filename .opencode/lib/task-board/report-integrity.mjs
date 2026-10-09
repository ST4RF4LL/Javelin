import { boundFile, verifySeal, validateBacFindingBindings } from "../bac/contract.mjs";

// A deterministic preflight, not a replacement for independent content review.
// Legacy text/malformed reports still enter the existing quality-gap workflow.
export async function checkReportIntegrity(bytes, { reportsRoot, taskId }) {
  let report;
  try { report = JSON.parse(bytes.toString("utf8")); } catch { return; }
  const attachment = report?.bac_analysis;
  if (!attachment?.review) return;
  const { value: review } = await boundFile(reportsRoot, attachment.review);
  verifySeal(review);
  validateBacFindingBindings(report.findings, review, taskId);
}
