import fs from 'node:fs';
import path from 'node:path';
const GIB = 1024n ** 3n;
const RESERVE = 20n * GIB;
const POLICY = Object.freeze({
  context: Object.freeze({ cMinimumBytes: RESERVE, dMinimumBytes: 22n * GIB, dNextCellAllowanceBytes: 2n * GIB }),
  swe: Object.freeze({ cMinimumBytes: RESERVE, dMinimumBytes: 28n * GIB, dNextCellAllowanceBytes: 8n * GIB }),
});

const absolute = (value, label) => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return value;
};

function freeBytes(stat) {
  return BigInt(stat.bavail) * BigInt(stat.bsize);
}

function appendGate(gateLogPath, record) {
  fs.mkdirSync(path.dirname(gateLogPath), { recursive: true });
  fs.appendFileSync(gateLogPath, `${JSON.stringify(record)}\n`, 'utf8');
}

/** Wrap the real campaign executor with one admission check per new cell. */
export function makeGuardedExecute({ cohort, gateLogPath, executeCampaign, runtimeVolumePath, evidenceVolumePath, statfsSync = fs.statfsSync }) {
  if (!Object.hasOwn(POLICY, cohort)) throw new Error('cohort must be context or swe');
  absolute(gateLogPath, 'gateLogPath');
  absolute(runtimeVolumePath, 'runtimeVolumePath'); absolute(evidenceVolumePath, 'evidenceVolumePath');
  if (typeof executeCampaign !== 'function') throw new Error('executeCampaign must be a function');
  const policy = POLICY[cohort];

  return async (...args) => {
    const [manifestPath, mode, slotId] = args;
    let cBytes;
    let dBytes;
    try {
      cBytes = freeBytes(statfsSync(runtimeVolumePath));
      dBytes = freeBytes(statfsSync(evidenceVolumePath));
    } catch (error) {
      appendGate(gateLogPath, {
        at: new Date().toISOString(), cohort, manifestPath, mode, nextSlot: slotId,
        freeBytes: { c: cBytes === undefined ? null : String(cBytes), d: dBytes === undefined ? null : String(dBytes) },
        policy: { cMinimumBytes: String(policy.cMinimumBytes), dMinimumBytes: String(policy.dMinimumBytes),
          dNextCellAllowanceBytes: String(policy.dNextCellAllowanceBytes), reserveBytes: String(RESERVE) },
        admitted: false, statfsError: error.message,
      });
      throw error;
    }

    const admitted = cBytes >= policy.cMinimumBytes && dBytes >= policy.dMinimumBytes;
    appendGate(gateLogPath, {
      at: new Date().toISOString(), cohort, manifestPath, mode, nextSlot: slotId,
      freeBytes: { c: String(cBytes), d: String(dBytes) },
      policy: { cMinimumBytes: String(policy.cMinimumBytes), dMinimumBytes: String(policy.dMinimumBytes),
        dNextCellAllowanceBytes: String(policy.dNextCellAllowanceBytes), reserveBytes: String(RESERVE) },
      admitted,
    });
    if (!admitted) {
      throw new Error(`Disk admission denied before campaign execution for ${slotId}: requires C >= ${policy.cMinimumBytes} and D >= ${policy.dMinimumBytes} bytes`);
    }
    return await executeCampaign(...args);
  };
}

