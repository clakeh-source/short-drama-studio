/**
 * Shot duration planning.
 *
 * Pure and provider-aware-by-injection, so it can be unit-tested and reused by
 * the storyboard generator, the split/merge editors and the cost panel.
 *
 * The model is asked to budget its own durations, but models are unreliable
 * arithmetic engines and hosted video providers only render a handful of
 * durations. So its numbers are treated as intent and then *fitted* to the
 * provider's grid and the episode's budget deterministically. That is what
 * makes Phase 2 AC #1 a property of the code rather than a hope.
 */

export const MIN_SHOT_SECONDS = 3;
export const MAX_SHOT_SECONDS = 8;

/**
 * The longest single clip any hosted video model here will render.
 *
 * Distinct from `MAX_SHOT_SECONDS`, which is an editorial ceiling for coverage
 * the model plans from scratch — an 8-second shot is already long for vertical
 * drama. This is a hard technical limit: Kling's per-clip ceiling. A shot longer
 * than this cannot be generated at all, whatever the storyboard says, so a
 * script breakdown that implies one has to become several shots.
 */
export const MAX_CLIP_SECONDS = 15;

/**
 * Splits any shot longer than the clip ceiling into as many as it needs.
 *
 * The breakdown prompt asks the model to do this itself, and it mostly does.
 * That is not enough to rely on: a shot over the ceiling is not a quality
 * problem to be nudged, it is a shot that will fail to generate. So the rule is
 * applied deterministically here as well, and the model's compliance stops being
 * load-bearing.
 *
 * Time is divided evenly and rounded, with the remainder on the first part, so
 * the pieces always sum back to the original duration — a 22-second shot becomes
 * 11 + 11, not 15 + 7. Even parts read as deliberate coverage; a stub tail reads
 * as a mistake.
 */
export function splitLongShots<T>(
  shots: readonly T[],
  durationOf: (shot: T) => number,
  withDuration: (shot: T, seconds: number, part: number, parts: number) => T,
): T[] {
  const out: T[] = [];

  for (const shot of shots) {
    const seconds = durationOf(shot);

    if (seconds <= MAX_CLIP_SECONDS) {
      out.push(shot);
      continue;
    }

    const parts = Math.ceil(seconds / MAX_CLIP_SECONDS);
    const base = Math.floor(seconds / parts);
    let remainder = seconds - base * parts;

    for (let part = 0; part < parts; part++) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      out.push(withDuration(shot, base + extra, part, parts));
    }
  }

  return out;
}

/**
 * The durations a provider will actually render, derived by asking it to clamp
 * every value in range and keeping the distinct answers.
 */
export function supportedDurations(clamp: (seconds: number) => number): number[] {
  const grid = new Set<number>();
  for (let s = MIN_SHOT_SECONDS; s <= MAX_SHOT_SECONDS; s += 1) {
    const value = clamp(s);
    if (value >= MIN_SHOT_SECONDS && value <= MAX_SHOT_SECONDS) grid.add(value);
  }
  const sorted = [...grid].sort((a, b) => a - b);
  return sorted.length > 0 ? sorted : [MIN_SHOT_SECONDS];
}

function nearest(grid: number[], value: number): number {
  return grid.reduce((best, candidate) =>
    Math.abs(candidate - value) <= Math.abs(best - value) ? candidate : best,
  );
}

function step(grid: number[], value: number, direction: 1 | -1): number | null {
  const index = grid.indexOf(value);
  if (index === -1) return nearest(grid, value);
  const next = grid[index + direction];
  return next ?? null;
}

/**
 * Snaps every duration onto the provider grid, then nudges individual shots one
 * grid step at a time — always the step that most reduces the distance to the
 * target — until no single move gets closer.
 *
 * Returns durations in the same order as the input. Never returns a value off
 * the grid, and never returns fewer or more entries than it was given.
 */
export function fitShotDurations(
  requested: number[],
  targetSeconds: number,
  clamp: (seconds: number) => number,
): number[] {
  if (requested.length === 0) return [];

  const grid = supportedDurations(clamp);
  const durations = requested.map((d) => nearest(grid, d));

  if (targetSeconds <= 0) return durations;

  const distance = (total: number) => Math.abs(total - targetSeconds);
  let total = durations.reduce((a, b) => a + b, 0);

  // At most one move per shot per direction; bounded so it always terminates.
  const maxMoves = durations.length * grid.length + 1;

  for (let move = 0; move < maxMoves; move++) {
    let bestIndex = -1;
    let bestValue = 0;
    let bestDistance = distance(total);

    for (let i = 0; i < durations.length; i++) {
      const current = durations[i]!;
      for (const direction of [1, -1] as const) {
        const candidate = step(grid, current, direction);
        if (candidate === null || candidate === current) continue;
        const candidateDistance = distance(total - current + candidate);
        if (candidateDistance < bestDistance) {
          bestDistance = candidateDistance;
          bestIndex = i;
          bestValue = candidate;
        }
      }
    }

    if (bestIndex === -1) break;
    total = total - durations[bestIndex]! + bestValue;
    durations[bestIndex] = bestValue;
  }

  return durations;
}

/**
 * How many shots a target duration wants. Short drama cuts fast — roughly one
 * shot every 4 seconds — and the spec's own criterion is 10-20 shots for 60s.
 */
export function shotCountRange(targetSeconds: number): { min: number; max: number } {
  return {
    min: Math.max(2, Math.round(targetSeconds / 6)),
    max: Math.max(3, Math.round(targetSeconds / 3)),
  };
}

export function totalShotSeconds(durations: number[]): number {
  return durations.reduce((a, b) => a + b, 0);
}

/* -------------------------------------------------------------------------- */
/* Fitting the shot count                                                     */
/* -------------------------------------------------------------------------- */

/** The minimum a shot needs to be splittable into two legal clips. */
const SPLITTABLE_SECONDS = MIN_SHOT_SECONDS * 2;

export interface FittableShot {
  action: string;
  dialogue?: string | null;
  speaker?: string | null;
  characters: string[];
  duration_seconds: number;
  camera: string;
}

export interface FittableScene<TShot extends FittableShot> {
  shots: TShot[];
}

/**
 * Brings the total shot count inside `[min, max]`.
 *
 * Coverage is the model's call, but the count is a product constraint (Phase 2
 * AC #1), and a model asked for "10 to 20 shots" will sometimes return 26. Same
 * approach as the durations: treat its output as intent, then fit.
 *
 * Over budget → merge the two shortest adjacent shots in the busiest scene,
 * which is what trimming coverage actually looks like. Under budget → split the
 * longest shot that is long enough to yield two legal clips.
 *
 * Scenes are never emptied and never dropped: every scene keeps at least one
 * shot, so nothing silently disappears from the render.
 */
export function fitShotCount<TShot extends FittableShot>(
  scenes: Array<FittableScene<TShot>>,
  range: { min: number; max: number },
): Array<FittableScene<TShot>> {
  const next = scenes.map((scene) => ({ ...scene, shots: [...scene.shots] }));
  const total = () => next.reduce((n, s) => n + s.shots.length, 0);

  // Merging cannot go below one shot per scene.
  const floor = next.length;
  const effectiveMax = Math.max(range.max, floor);

  let guard = 0;
  while (total() > effectiveMax && guard < 500) {
    guard += 1;

    // The busiest scene, since that is where coverage is most redundant.
    const scene = next
      .filter((s) => s.shots.length > 1)
      .reduce<FittableScene<TShot> | null>(
        (best, candidate) => (!best || candidate.shots.length > best.shots.length ? candidate : best),
        null,
      );
    if (!scene) break;

    // The adjacent pair whose combined length still fits one clip.
    let bestIndex = 0;
    let bestPair = Infinity;
    for (let i = 0; i < scene.shots.length - 1; i++) {
      const pair = scene.shots[i]!.duration_seconds + scene.shots[i + 1]!.duration_seconds;
      if (pair < bestPair) {
        bestPair = pair;
        bestIndex = i;
      }
    }

    const first = scene.shots[bestIndex]!;
    const second = scene.shots[bestIndex + 1]!;
    scene.shots.splice(bestIndex, 2, {
      ...first,
      action: `${first.action} ${second.action}`.trim(),
      dialogue: first.dialogue ?? second.dialogue ?? null,
      speaker: first.speaker ?? second.speaker ?? null,
      characters: [...new Set([...first.characters, ...second.characters])],
      duration_seconds: Math.min(
        MAX_SHOT_SECONDS,
        first.duration_seconds + second.duration_seconds,
      ),
    } as TShot);
  }

  guard = 0;
  while (total() < range.min && guard < 500) {
    guard += 1;

    let target: { scene: FittableScene<TShot>; index: number } | null = null;
    let longest = 0;
    for (const scene of next) {
      for (const [index, shot] of scene.shots.entries()) {
        if (shot.duration_seconds >= SPLITTABLE_SECONDS && shot.duration_seconds > longest) {
          longest = shot.duration_seconds;
          target = { scene, index };
        }
      }
    }
    // Nothing left long enough to divide — the board is as dense as it can be.
    if (!target) break;

    const shot = target.scene.shots[target.index]!;
    const first = Math.max(MIN_SHOT_SECONDS, Math.floor(shot.duration_seconds / 2));
    const second = Math.max(MIN_SHOT_SECONDS, shot.duration_seconds - first);

    target.scene.shots.splice(target.index, 1, { ...shot, duration_seconds: first }, {
      ...shot,
      action: `${shot.action} (continued)`,
      dialogue: null,
      speaker: null,
      duration_seconds: second,
    } as TShot);
  }

  return next;
}

export function shotDurationDrift(durations: number[], targetSeconds: number): number {
  if (targetSeconds <= 0) return 0;
  return Math.abs(totalShotSeconds(durations) - targetSeconds) / targetSeconds;
}

/* -------------------------------------------------------------------------- */
/* Voice fit                                                                  */
/* -------------------------------------------------------------------------- */

/** A voice clip needs a bit of headroom inside its shot, not an exact fit. */
export const VOICE_HEADROOM_SECONDS = 0.25;

/**
 * Whether a synthesised line runs past the end of its shot (Phase 3 AC #7).
 *
 * Lives here rather than beside the voice job because three places need it — the
 * job, the status endpoint and the generation page — and the data layer cannot
 * import from `lib/inngest/functions/*` without creating a cycle, since those
 * functions import the data layer. It is a fact about shots, so this is its home.
 */
export function voiceOverruns(voiceSeconds: number, shotSeconds: number): boolean {
  return voiceSeconds > shotSeconds - VOICE_HEADROOM_SECONDS;
}
