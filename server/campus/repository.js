// Share the account-scoped scenario document and its PostgreSQL CAS transaction.
import { readScenarioData, mutateScenarioData } from '../scenarios/repository.js';
import { emptyCampus } from './domain.js';
export async function readCampus() { return (await readScenarioData()).campus || emptyCampus(); }
export async function mutateCampus(change) {
  return mutateScenarioData(data => { data.campus ||= emptyCampus(); return change(data.campus); });
}
