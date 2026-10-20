// Test-only policy extracted from closed-phase-auditor/audit.mjs. Raw source pin: 1ed367b30009dd0c58cfa1ef1142098ee9b7a708c4f7fa21d95dbf9847e11de9.
const MISSING_CONTEXT = ['missing-final-declaration', 'invalid-final-json', 'invalid-final-schema', 'invalid-final-region'];
export function acceptedGrade(meta, cohort) {
  const grade = meta.grade;
  if (grade?.cleanup?.status === 'failed' || grade?.cleanupError) return false;
  if (grade?.status === 'completed') return true;
  if (cohort === 'context' && grade?.missingFinalDeclaration === true && MISSING_CONTEXT.includes(grade.status)) return true;
  return cohort === 'swe' && grade?.emptyModelPatch === true && grade?.status === 'missing-report' &&
    grade.receipt?.processExit?.code === 0 && grade.receipt.timedOut === false && grade.receipt.processError === null &&
    !grade.receipt.officialInfrastructureFailure && grade.cleanup?.status === 'completed';
}
