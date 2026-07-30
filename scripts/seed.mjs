#!/usr/bin/env node
/**
 * Seeds one complete series so later phases have something to work against:
 *
 *   series → 2 characters
 *          → episode 1 → 2 scenes → 4 shots (2 per scene)
 *
 * Idempotent. Re-running drops the seed series and rebuilds it, which cascades
 * through every child row — so this is safe to run repeatedly but will discard
 * generated clips attached to the seed episode. It touches nothing else.
 *
 * DEVELOPMENT ONLY. Needs SUPABASE_SERVICE_ROLE_KEY (to resolve the dev user)
 * and DATABASE_URL. The connection role bypasses RLS.
 *
 *   node scripts/seed.mjs [email]
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

const here = dirname(fileURLToPath(import.meta.url));

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const databaseUrl = process.env.DATABASE_URL;

if (!supabaseUrl || !serviceKey || !databaseUrl) {
  console.error(
    'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL must be set.',
  );
  process.exit(1);
}

const email = process.argv[2] ?? 'dev@example.com';

/* -------------------------------------------------------------------------- */
/* The seed data                                                              */
/* -------------------------------------------------------------------------- */

const SERIES_TITLE = 'The Last Ferry';

/**
 * Two speaking parts, because a one-character seed would not exercise the
 * per-character reference sets that Phase 2 builds or the multi-character
 * prompts Phase 4 assembles.
 */
const CAST = [
  {
    key: 'mei',
    name: 'Mei Lin',
    role: 'lead',
    description:
      'A harbour-freight clerk who has spent three days proving her brother boarded a ferry ' +
      'he was never ticketed for. Careful, unhurried, and entirely out of patience.',
    appearancePrompt:
      'East Asian woman in her early thirties, sharp jaw, black hair pulled back and wet from ' +
      'rain, olive canvas jacket over a grey sweater, no jewellery, tired eyes',
  },
  {
    key: 'daniel',
    name: 'Daniel Voss',
    role: 'antagonist',
    description:
      'Travelling on a boarding pass with someone else’s name on it. Calm in the way people ' +
      'are when they have done this before.',
    appearancePrompt:
      'White man in his mid forties, silver-flecked dark hair swept back, heavy charcoal wool ' +
      'overcoat, open collar, leather dress shoes soaked through, unreadable expression',
  },
];

/**
 * Shot durations are all inside Kling's per-clip ceiling on purpose — the
 * breakdown in Phase 3 splits anything longer, and the seed should look like
 * its output rather than like input it has to fix.
 */
const SCENES = [
  {
    location: 'Harbour terminal, closed ticket window',
    timeOfDay: 'night',
    summary:
      'Mei learns her brother is not on the manifest and works out that someone boarded ' +
      'under his name.',
    shots: [
      {
        camera: 'wide',
        action:
          'Rain sheets down the terminal glass. Mei stands alone at the shuttered ticket ' +
          'window, duffel bag still on her shoulder, as the departures board flips to DELAYED.',
        dialogue: null,
        speaker: null,
        cast: ['mei'],
        durationSeconds: 5,
      },
      {
        camera: 'close-up',
        action:
          'Mei lifts her phone to her ear, one bar of signal, and speaks without looking away ' +
          'from the board. A metal shutter slams down somewhere behind her.',
        dialogue: 'He’s not on the manifest. I checked it twice.',
        speaker: 'mei',
        cast: ['mei'],
        durationSeconds: 5,
      },
    ],
  },
  {
    location: 'Ferry deck, stern rail',
    timeOfDay: 'night',
    summary: 'Daniel watches the terminal recede. Mei finds him, and neither pretends.',
    shots: [
      {
        camera: 'medium',
        action:
          'The engines shudder awake. Daniel stands at the stern rail in a soaked overcoat, ' +
          'watching the terminal lights pull away, a boarding pass held loosely at his side.',
        dialogue: 'You should have stayed on the dock.',
        speaker: 'daniel',
        cast: ['daniel'],
        durationSeconds: 5,
      },
      {
        camera: 'two-shot',
        action:
          'Mei steps out of the stairwell behind him and sets the duffel down for the first ' +
          'time all night. Daniel does not turn around.',
        dialogue: 'And you should have used a different name.',
        speaker: 'mei',
        cast: ['mei', 'daniel'],
        durationSeconds: 10,
      },
    ],
  },
];

/**
 * The same episode in the shape `episodes.script` holds — the structured form
 * the storyboard reads. `scripts/seed/episode-1.txt` is the raw screenplay it
 * came from, kept alongside so the Phase 3 breakdown has real text to parse.
 */
const SCRIPT = {
  hook: 'The departures board flips to DELAYED and the name she is looking for is not on it.',
  cliffhanger: 'And you should have used a different name.',
  scenes: SCENES.map((scene) => ({
    location: scene.location,
    time_of_day: scene.timeOfDay,
    summary: scene.summary,
    beats: scene.shots.map((shot) => ({
      action: shot.action,
      dialogue: shot.dialogue,
      speaker: shot.speaker ? CAST.find((c) => c.key === shot.speaker).name : null,
    })),
  })),
};

/* -------------------------------------------------------------------------- */
/* Insert                                                                     */
/* -------------------------------------------------------------------------- */

const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

// Create the dev user on first run; "already registered" is the expected path
// on every run after that.
const { error: createError } = await supabase.auth.admin.createUser({
  email,
  email_confirm: true,
});
if (createError && !/already/i.test(createError.message)) {
  console.error(`Could not create ${email}: ${createError.message}`);
  process.exit(1);
}

const { data: list, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
if (listError) {
  console.error(`Could not list users: ${listError.message}`);
  process.exit(1);
}

const user = list.users.find((u) => u.email === email);
if (!user) {
  console.error(`No user found for ${email}.`);
  process.exit(1);
}

const sql = postgres(databaseUrl, { prepare: false, max: 1 });

try {
  await sql.begin(async (tx) => {
    // Idempotency. The FK cascade takes the episode, scenes, shots, characters,
    // reference images and any generated assets with it.
    // Reference stills live in Storage, and the FK cascade cannot reach them —
    // dropping the series alone would leave their objects in the bucket with
    // nothing left pointing at them. Clear them first, while the rows that name
    // them still exist.
    const stills = await tx`
      select ri.storage_path
      from character_reference_images ri
      join characters c on c.id = ri.character_id
      join series s on s.id = c.series_id
      where s.user_id = ${user.id} and s.title = ${SERIES_TITLE}
    `;

    for (const { storage_path: path } of stills) {
      const slash = path.indexOf('/');
      const { error } = await supabase.storage
        .from(path.slice(0, slash))
        .remove([path.slice(slash + 1)]);
      if (error) console.warn(`  ! could not remove ${path}: ${error.message}`);
    }

    const [removed] = await tx`
      delete from series where user_id = ${user.id} and title = ${SERIES_TITLE}
      returning id
    `;
    if (removed) {
      console.log(
        `· removed the previous "${SERIES_TITLE}" (${removed.id})` +
          (stills.length > 0 ? ` and ${stills.length} reference stills` : ''),
      );
    }

    const seriesId = randomUUID();
    await tx`
      insert into series (id, user_id, title, logline, genre, tone, audience, language,
                          episode_target_count, episode_target_seconds, script_source, status)
      values (${seriesId}, ${user.id}, ${SERIES_TITLE},
              ${'A freight clerk follows her missing brother’s name onto a ferry he never boarded.'},
              ${'revenge thriller'}, ${'cold, rain-soaked, close'}, ${'adults 25-44'}, ${'en'},
              ${1}, ${60}, ${'user_provided'}, ${'active'})
    `;

    const characterIds = {};
    for (const member of CAST) {
      const characterId = randomUUID();
      characterIds[member.key] = characterId;
      await tx`
        insert into characters (id, series_id, name, role, description, appearance_prompt)
        values (${characterId}, ${seriesId}, ${member.name}, ${member.role},
                ${member.description}, ${member.appearancePrompt})
      `;
    }

    const episodeId = randomUUID();
    await tx`
      insert into episodes (id, series_id, number, title, synopsis, hook, cliffhanger,
                            script, status)
      values (${episodeId}, ${seriesId}, ${1}, ${'Manifest'},
              ${'Mei traces a boarding pass issued in her brother’s name to the man using it.'},
              ${SCRIPT.hook}, ${SCRIPT.cliffhanger}, ${sql.json(SCRIPT)}, ${'storyboarded'})
    `;

    let sceneIndex = 0;
    let shotCount = 0;

    for (const scene of SCENES) {
      const sceneId = randomUUID();
      await tx`
        insert into scenes (id, episode_id, order_index, location, time_of_day, summary)
        values (${sceneId}, ${episodeId}, ${sceneIndex}, ${scene.location},
                ${scene.timeOfDay}, ${scene.summary})
      `;

      let shotIndex = 0;
      for (const shot of scene.shots) {
        const cast = shot.cast.map((key) => characterIds[key]);
        await tx`
          insert into shots (id, scene_id, order_index, duration_seconds, camera, action,
                             dialogue, speaker_character_id, character_ids, video_prompt,
                             status)
          values (${randomUUID()}, ${sceneId}, ${shotIndex}, ${shot.durationSeconds},
                  ${shot.camera}, ${shot.action}, ${shot.dialogue},
                  ${shot.speaker ? characterIds[shot.speaker] : null},
                  ${cast}::uuid[],
                  ${`${shot.camera} shot. ${shot.action} Location: ${scene.location}, ${scene.timeOfDay}.`},
                  ${'pending'})
        `;
        shotIndex += 1;
        shotCount += 1;
      }

      sceneIndex += 1;
    }

    console.log(`✓ ${SERIES_TITLE}  (series ${seriesId})`);
    console.log(`  ${CAST.length} characters, 1 episode, ${SCENES.length} scenes, ${shotCount} shots`);
  });

  const raw = await readFile(join(here, 'seed', 'episode-1.txt'), 'utf8');
  console.log(`  raw script for the Phase 3 breakdown: scripts/seed/episode-1.txt (${raw.length} chars)`);
  console.log(`\nSign in as ${email}:  node scripts/dev-login.mjs ${email}`);
} finally {
  await sql.end({ timeout: 5 });
}
