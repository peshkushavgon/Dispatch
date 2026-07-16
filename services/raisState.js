import fs from 'fs';
import path from 'path';

function getStateFile() {
  return process.env.RAIS_STATE_FILE
    ? path.resolve(process.env.RAIS_STATE_FILE)
    : path.resolve(process.cwd(), 'rais-state.json');
}

function createInitialState() {
  return {
    activityLog: [],
    sentToday: 0,
    filesToday: 0,
    errorsToday: 0,
    startedAt: new Date().toISOString(),
  };
}

function loadState() {
  const stateFile = getStateFile();

  try {
    if (!fs.existsSync(stateFile)) return createInitialState();
    return { ...createInitialState(), ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
  } catch (error) {
    console.error(`[RAIS] Could not read state: ${error.message}`);
    return createInitialState();
  }
}

export const raisState = loadState();

export function saveRaisState() {
  const stateFile = getStateFile();
  const temporaryFile = `${stateFile}.tmp`;

  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(temporaryFile, JSON.stringify(raisState, null, 2), 'utf8');
    fs.renameSync(temporaryFile, stateFile);
  } catch (error) {
    console.error(`[RAIS] Could not save state: ${error.message}`);
  }
}

export function logRaisActivity(entry) {
  raisState.activityLog.unshift(entry);
  if (raisState.activityLog.length > 100) raisState.activityLog.length = 100;
  saveRaisState();
}

function scheduleDailyReset() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);

  const timer = setTimeout(() => {
    raisState.sentToday = 0;
    raisState.filesToday = 0;
    raisState.errorsToday = 0;
    saveRaisState();
    scheduleDailyReset();
  }, next.getTime() - now.getTime());

  timer.unref?.();
}

scheduleDailyReset();
