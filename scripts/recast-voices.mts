/**
 * Recasts characters whose voice the TTS account cannot actually use.
 *
 *   pnpm recast:voices            # what it would change
 *   pnpm recast:voices --apply    # change it
 *
 * Casting picks a voice once, when the bible is written, and the refusal for an
 * unusable one arrives per line at the voice stage — so a character cast badly
 * is mute in every episode until someone notices. `listVoices` now only offers
 * voices that work, but characters cast *before* that keep their old ids, and
 * nothing re-examines them.
 *
 * Only the broken ones move. A voice that already works is left alone, because
 * reshuffling a cast that sounds right is not a fix — and the whole point of
 * `assignDefaultVoices` being deterministic is that voices stay put.
 *
 * Written as a .mts and run through tsx so it uses the real provider and the
 * real picker rather than a second copy of either. A script that reimplements
 * the rule it is enforcing is how the two drift apart.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { ElevenLabsTtsProvider } from '../lib/providers/elevenlabs/tts';
import { assignDefaultVoices } from '../lib/voices';

config({ path: '.env.local', quiet: true });

const apply = process.argv.includes('--apply');

const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

try {
  const usable = await new ElevenLabsTtsProvider().listVoices();
  const usableIds = new Set(usable.map((v) => v.id));
  console.log(`${usable.length} voices this account can synthesise with.\n`);

  const rows = await sql<
    Array<{ id: string; name: string; role: string; voice_id: string | null; series: string; series_id: string }>
  >`
    select c.id, c.name, coalesce(c.role, '') as role, c.voice_id,
           s.title as series, s.id as series_id
    from characters c
    join series s on s.id = c.series_id
    order by s.title, c.created_at`;

  const bySeries = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySeries.get(row.series_id) ?? [];
    list.push(row);
    bySeries.set(row.series_id, list);
  }

  let changed = 0;

  for (const cast of bySeries.values()) {
    // A character with no voice at all is as mute as one with a bad voice, so
    // both count as needing a cast.
    const broken = cast.filter((c) => !c.voice_id || !usableIds.has(c.voice_id));
    if (broken.length === 0) continue;

    console.log(cast[0]!.series);

    /**
     * Voices already in use *and working* in this series are off the table, so
     * recasting one character does not give them a colleague's voice. Distinct
     * voices matter most in exactly the two-handers this app writes.
     */
    const taken = new Set(
      cast.filter((c) => c.voice_id && usableIds.has(c.voice_id)).map((c) => c.voice_id!),
    );
    const available = usable.filter((v) => !taken.has(v.id));

    const assignment = assignDefaultVoices(
      broken.map((c) => ({ name: c.name, role: c.role })),
      available,
    );

    for (const character of broken) {
      const next = assignment.get(character.name);
      if (!next) continue;

      const was = character.voice_id ? character.voice_id.slice(0, 8) + '…' : 'none';
      const voiceName = usable.find((v) => v.id === next)?.name ?? next;
      console.log(`  ${character.name.padEnd(20)} ${was.padEnd(12)} -> ${voiceName}`);

      if (apply) {
        await sql`update characters set voice_id = ${next} where id = ${character.id}`;
      }
      changed++;
    }
    console.log();
  }

  console.log(
    changed === 0
      ? 'Every character already has a usable voice.'
      : apply
        ? `Recast ${changed} character${changed === 1 ? '' : 's'}.`
        : `${changed} character${changed === 1 ? '' : 's'} would be recast. Re-run with --apply.`,
  );
} finally {
  await sql.end();
}
