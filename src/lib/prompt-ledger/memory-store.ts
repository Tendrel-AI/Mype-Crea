import { DuplicateRunError } from './errors';
import type { LedgerStore } from './ports';
import type { Feedback, PromptVersion, Run, RunKind, Sample, Score } from './types';

// Copies on the way in and out so callers can never alias store state.
const copy = <T>(x: T): T => structuredClone(x);

export class InMemoryLedgerStore implements LedgerStore {
  private versions = new Map<string, PromptVersion>();
  private runs: Run[] = [];
  private scores: Score[] = [];
  private samples: Sample[] = [];
  private feedback = new Map<string, Feedback>();

  async insertVersionIfAbsent(v: PromptVersion) {
    const k = `${v.key}\0${v.version}`;
    if (!this.versions.has(k)) this.versions.set(k, copy(v));
    return copy(this.versions.get(k)!);
  }
  async getVersion(key: string, version: string) {
    const v = this.versions.get(`${key}\0${version}`);
    return v ? copy(v) : null;
  }
  async listVersions(key: string) {
    return [...this.versions.values()].filter((v) => v.key === key).map(copy);
  }
  // No await between the check and the writes, so check+write is atomic here.
  async insertRun(run: Run, scores: Score[], samples: Sample[]) {
    if (this.runs.some((r) => r.id === run.id)) throw new DuplicateRunError(run.id);
    this.runs.push(copy(run));
    this.scores.push(...scores.map(copy));
    this.samples.push(...samples.map(copy));
  }
  async upsertFeedback(fb: Feedback) {
    this.feedback.set(`${fb.subjectId}\0${fb.raterId}`, copy(fb));
  }
  async listRuns(key: string, version: string, kind?: RunKind) {
    return this.runs.filter((r) => r.key === key && r.version === version && (!kind || r.kind === kind)).map(copy);
  }
  async listScores(runIds: string[]) {
    const ids = new Set(runIds);
    return this.scores.filter((s) => ids.has(s.runId)).map(copy);
  }
  async countSamples(runIds: string[]) {
    const ids = new Set(runIds);
    return this.samples.filter((s) => ids.has(s.runId)).length;
  }
  async listFeedback(key: string, version: string) {
    return [...this.feedback.values()].filter((f) => f.key === key && f.version === version).map(copy);
  }
}
