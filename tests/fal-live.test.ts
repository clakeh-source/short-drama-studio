import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FalImageProvider, identityModel } from '@/lib/providers/fal/image';
import { FalVideoProvider, imageToVideoModel } from '@/lib/providers/fal/video';

/**
 * The live check. **This spends real money** — roughly 60c a run — so it is off
 * unless `FAL_LIVE=1` is set:
 *
 *   FAL_LIVE=1 pnpm vitest run tests/fal-live.test.ts
 *
 * Everything else in this suite is derived from fal's OpenAPI schemas, which is
 * better evidence than docs prose and is still not proof. Three claims can only
 * be settled by a real call, and each of them fails in a way that looks like
 * success from the inside:
 *
 *   1. `start_image_url` is the field this endpoint wants. Wrong name, and the
 *      submission is refused — or worse, accepted with the frame ignored.
 *   2. `elements` is accepted and holds several faces. This is the thing the
 *      last five commits exist for.
 *   3. The identity image model composes two people into one frame, rather than
 *      quietly using the first and inventing the second.
 *
 * The steps run in order and each depends on the last, so they share state
 * rather than being independent — a failure early makes the rest meaningless.
 */

const LIVE = process.env.FAL_LIVE === '1';
const MINUTES = 60_000;

const exec = promisify(execFile);

/** Two people who do not exist, so nothing here depends on a real likeness. */
const CAST = [
  {
    name: 'Mei Lin',
    prompt:
      'Studio portrait photograph, East Asian woman in her early thirties, sharp jaw, ' +
      'dark hair pulled into a low knot, olive canvas jacket, neutral grey backdrop, ' +
      'even lighting, facing camera.',
  },
  {
    name: 'Daniel Voss',
    prompt:
      'Studio portrait photograph, white man in his early forties, close-cropped greying ' +
      'hair, faint scar through the right eyebrow, navy overcoat, neutral grey backdrop, ' +
      'even lighting, facing camera.',
  },
];

const SHOT_PROMPT =
  'Two-shot. Mei Lin and Daniel Voss face each other across a rain-slicked ferry terminal ' +
  'barrier at night, sodium lights overhead, neither of them moving. Handheld, shallow depth ' +
  'of field.';

const state: { faces: string[]; keyframe: string | null; video: string | null } = {
  faces: [],
  keyframe: null,
  video: null,
};

/**
 * Skip rather than fail when the step before this one produced nothing.
 *
 * These steps are a chain, and without this a refusal at step one reports as
 * four failures: the real one, and three null-dereferences downstream that say
 * nothing and bury it. An empty fal balance should read as one clear problem.
 */
function needs(condition: unknown, context: { skip: () => void }): void {
  if (!condition) context.skip();
}

describe.skipIf(!LIVE)('fal, for real', () => {
  it(
    'draws a face for each character',
    async () => {
      const provider = new FalImageProvider();

      for (const member of CAST) {
        const { images, costCents } = await provider.generate({
          prompt: member.prompt,
          count: 1,
          aspectRatio: '9:16',
        });

        expect(images[0]?.url).toMatch(/^https?:\/\//);
        state.faces.push(images[0]!.url);
        console.log(`[live] ${member.name}: ${images[0]!.url} (${costCents}c)`);
      }

      expect(state.faces).toHaveLength(2);
    },
    5 * MINUTES,
  );

  it(
    'composes both faces into one keyframe',
    async (ctx) => {
      needs(state.faces.length === 2, ctx);

      // The claim under test: a multi-identity model reads `image_urls` and
      // puts *both* people in the frame. A single-identity model would accept
      // this request, use the first face and invent the second — which is
      // exactly the failure that started all of this, and is invisible in a
      // thumbnail.
      const provider = new FalImageProvider();
      const request = provider.buildRequest({
        prompt: SHOT_PROMPT,
        count: 1,
        aspectRatio: '9:16',
        identityImageUrls: state.faces,
      });

      expect(request.model).toBe(identityModel());
      expect(request.facesUsed).toBe(2);
      expect(request.body.image_urls).toEqual(state.faces);

      const { images, costCents } = await provider.generate({
        prompt: SHOT_PROMPT,
        count: 1,
        aspectRatio: '9:16',
        identityImageUrls: state.faces,
      });

      state.keyframe = images[0]?.url ?? null;
      expect(state.keyframe).toMatch(/^https?:\/\//);
      console.log(`[live] keyframe: ${state.keyframe} (${costCents}c)`);
    },
    5 * MINUTES,
  );

  it(
    'is accepted by Kling with a start frame and a cast',
    async (ctx) => {
      needs(state.keyframe, ctx);

      // The submission is the assertion. A wrong field name, an `elements`
      // shape the endpoint does not recognise, or an angle count above what it
      // takes all come back as a 422 here rather than as a bad clip later.
      const provider = new FalVideoProvider();
      const input = {
        prompt: SHOT_PROMPT,
        durationSeconds: 5,
        aspectRatio: '9:16' as const,
        referenceImageUrls: [state.keyframe!],
        castReferences: CAST.map((member, index) => ({
          name: member.name,
          urls: [state.faces[index]!],
        })),
      };

      const request = provider.buildRequest(input);
      expect(request.model).toBe(imageToVideoModel());
      expect(request.body.start_image_url).toBe(state.keyframe);
      expect(request.elementsUsed).toBe(2);
      expect(request.body.prompt).toContain('@Element1');
      expect(request.body.prompt).toContain('@Element2');

      const { providerJobId, meta } = await provider.generate(input);

      expect(providerJobId).toContain('#');
      expect(meta).toMatchObject({ elementsUsed: 2, castRequested: 2 });
      console.log(`[live] submitted: ${providerJobId}`);

      state.video = providerJobId;
    },
    5 * MINUTES,
  );

  it(
    'renders a playable clip of the right length',
    async (ctx) => {
      needs(state.video, ctx);

      const provider = new FalVideoProvider();
      const deadline = Date.now() + 12 * MINUTES;

      let url: string | null = null;
      while (Date.now() < deadline) {
        const result = await provider.poll(state.video!);
        if (result.status === 'ready') {
          url = result.url;
          console.log(`[live] ready: ${result.url} (${result.costCents}c)`);
          break;
        }
        expect(result.status).toBe('pending');
        await new Promise((r) => setTimeout(r, 15_000));
      }

      expect(url).toMatch(/^https?:\/\//);

      // Downloaded and probed rather than trusted: "the provider returned a
      // URL" and "there is a video at it" are different claims.
      const response = await fetch(url!);
      const bytes = Buffer.from(await response.arrayBuffer());
      const dir = await mkdtemp(join(tmpdir(), 'fal-live-'));
      const file = join(dir, 'clip.mp4');
      await writeFile(file, bytes);

      const { stdout } = await exec(process.env.FFMPEG_PATH?.replace(/ffmpeg$/, 'ffprobe') ?? 'ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,duration',
        '-of', 'json',
        file,
      ]);

      const stream = JSON.parse(stdout).streams[0];
      console.log(`[live] clip: ${stream.width}x${stream.height}, ${stream.duration}s, ${bytes.length} bytes`);

      expect(bytes.length).toBeGreaterThan(100_000);
      expect(Number(stream.duration)).toBeGreaterThan(3);
      expect(Number(stream.height)).toBeGreaterThan(Number(stream.width));
      console.log(`[live] keyframe for eyeball: ${state.keyframe}`);
      console.log(`[live] clip for eyeball: ${url}`);
    },
    20 * MINUTES,
  );
});
