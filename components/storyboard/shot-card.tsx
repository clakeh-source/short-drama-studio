'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Combine,
  GripVertical,
  Loader2,
  RotateCcw,
  Scissors,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CAMERA_VOCABULARY, composeVideoPrompt } from '@/lib/ai/prompts';
import { MAX_SHOT_SECONDS, MIN_SHOT_SECONDS } from '@/lib/shots';
import { cn, formatCents } from '@/lib/utils';
import type { BoardCharacter, BoardScene, BoardShot } from './types';

export interface ShotCardProps {
  shot: BoardShot;
  scene: BoardScene;
  /** 1-based position across the whole episode, for the strip label. */
  displayNumber: number;
  cast: BoardCharacter[];
  styleSuffix: string | null;
  /** Series-level — see the note on `BoardShot`. */
  negativePrompt: string | null;
  estimateCents: number;
  busy: boolean;
  /** Highlighted by the j/k keyboard walk. Distinct from DOM focus. */
  keyboardFocused?: boolean;
  /** Clicking anywhere on the card makes it the keyboard target. */
  onSelect?: () => void;
  canMerge: boolean;
  onChange: (patch: Partial<BoardShot>) => void;
  onCommit: (patch: Partial<BoardShot>) => void;
  onSplit: () => void;
  onMerge: () => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: () => void;
  dragging: boolean;
  dropTarget: boolean;
}

export function ShotCard(props: ShotCardProps) {
  const { shot, scene, cast } = props;
  const [expanded, setExpanded] = useState(false);

  const shotCast = shot.characterIds
    .map((id) => cast.find((c) => c.id === id))
    .filter((c): c is BoardCharacter => Boolean(c));

  // Composed live from the current edits, using the same pure function the
  // server persists with — so the preview is the prompt, not an approximation.
  const composed = composeVideoPrompt({
    camera: shot.camera,
    action: shot.action,
    location: scene.location,
    timeOfDay: scene.timeOfDay,
    characters: shotCast.map((c) => ({
      id: c.id,
      name: c.name,
      appearancePrompt: c.appearancePrompt,
      role: c.role,
    })),
    styleSuffix: props.styleSuffix,
    override: null,
  });

  const overridden = Boolean(shot.promptOverride?.trim());
  const effectivePrompt = overridden ? shot.promptOverride! : composed;

  function toggleCharacter(id: string) {
    const next = shot.characterIds.includes(id)
      ? shot.characterIds.filter((c) => c !== id)
      : [...shot.characterIds, id];
    props.onCommit({ characterIds: next });
  }

  return (
    <div
      draggable
      data-shot-id={shot.id}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onMouseDown={props.onSelect}
      className={cn(
        'flex gap-3 rounded-xl border border-border bg-card p-3 transition-all',
        props.dragging && 'opacity-40',
        props.dropTarget && 'border-primary ring-1 ring-primary',
        // Keyboard focus, so j/k has somewhere visible to be.
        props.keyboardFocused && 'ring-2 ring-primary/70',
      )}
    >
      {/* 9:16 frame — the thing the shot will actually become. */}
      <div className="flex shrink-0 flex-col items-center gap-2">
        <button
          type="button"
          aria-label="Drag to reorder"
          className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </button>
        <div className="relative w-20 overflow-hidden rounded-md border border-border bg-muted/40 aspect-vertical">
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-1 text-center">
            <span className="font-mono text-lg font-semibold text-muted-foreground">
              {props.displayNumber}
            </span>
            <span className="text-[10px] leading-tight text-muted-foreground">{shot.camera}</span>
          </div>
          <span className="absolute bottom-1 right-1 rounded bg-background/80 px-1 font-mono text-[10px]">
            {shot.durationSeconds}s
          </span>
        </div>
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Camera"
            className="h-8 w-40 text-xs"
            value={shot.camera}
            onChange={(e) => props.onCommit({ camera: e.target.value })}
            disabled={props.busy}
          >
            {CAMERA_VOCABULARY.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>

          {shotCast.map((c) => (
            <Badge key={c.id} variant="secondary">
              {c.name}
            </Badge>
          ))}
          {shotCast.length === 0 ? <Badge variant="outline">no cast — insert</Badge> : null}
          {overridden ? <Badge variant="warning">prompt overridden</Badge> : null}

          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {formatCents(props.estimateCents)}
          </span>
        </div>

        <Textarea
          aria-label="Action"
          rows={2}
          className="text-sm"
          value={shot.action}
          onChange={(e) => props.onChange({ action: e.target.value })}
          onBlur={(e) => props.onCommit({ action: e.target.value })}
          disabled={props.busy}
        />

        <div className="flex flex-wrap items-center gap-2">
          <div className="w-40">
            <Select
              aria-label="Speaker"
              className="h-8 text-xs"
              value={shot.speakerCharacterId ?? ''}
              onChange={(e) =>
                props.onCommit({ speakerCharacterId: e.target.value || null })
              }
              disabled={props.busy}
            >
              <option value="">— no dialogue —</option>
              {cast.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <Input
            aria-label="Dialogue"
            className="h-8 min-w-40 flex-1 text-sm"
            placeholder="Line — under 12 words"
            value={shot.dialogue ?? ''}
            onChange={(e) => props.onChange({ dialogue: e.target.value || null })}
            onBlur={(e) => props.onCommit({ dialogue: e.target.value || null })}
            disabled={props.busy}
          />
        </div>

        <div className="flex items-center gap-3">
          <Label htmlFor={`duration-${shot.id}`} className="shrink-0 text-xs">
            Duration
          </Label>
          <input
            id={`duration-${shot.id}`}
            type="range"
            min={MIN_SHOT_SECONDS}
            max={MAX_SHOT_SECONDS}
            step={1}
            value={shot.durationSeconds}
            onChange={(e) => props.onChange({ durationSeconds: Number(e.target.value) })}
            onMouseUp={(e) =>
              props.onCommit({ durationSeconds: Number((e.target as HTMLInputElement).value) })
            }
            onTouchEnd={(e) =>
              props.onCommit({ durationSeconds: Number((e.target as HTMLInputElement).value) })
            }
            disabled={props.busy}
            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
          />
          <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums">
            {shot.durationSeconds}s
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs"
          >
            {expanded ? <ChevronUp /> : <ChevronDown />}
            Prompt
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onSplit} disabled={props.busy}>
            {props.busy ? <Loader2 className="animate-spin" /> : <Scissors />}
            Split
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onMerge}
            disabled={props.busy || !props.canMerge}
          >
            <Combine />
            Merge next
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onDelete}
            disabled={props.busy}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 />
            Delete
          </Button>
        </div>

        {expanded ? (
          <div className="space-y-3 rounded-lg border border-border bg-background/40 p-3">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <Label className="text-xs">In frame</Label>
                <span className="text-xs text-muted-foreground">
                  decides whose appearance is baked into the clip
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {cast.map((c) => {
                  const on = shot.characterIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleCharacter(c.id)}
                      disabled={props.busy}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs transition-colors',
                        on
                          ? 'border-primary bg-primary/15 text-primary'
                          : 'border-border text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <Label htmlFor={`prompt-${shot.id}`} className="text-xs">
                  {overridden ? 'Prompt override' : 'Composed prompt'}
                </Label>
                {overridden ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => props.onCommit({ promptOverride: null })}
                    disabled={props.busy}
                  >
                    <RotateCcw />
                    Revert to composed
                  </Button>
                ) : null}
              </div>
              <Textarea
                id={`prompt-${shot.id}`}
                rows={4}
                className="font-mono text-[11px] leading-relaxed"
                value={effectivePrompt}
                onChange={(e) => props.onChange({ promptOverride: e.target.value })}
                onBlur={(e) => {
                  const value = e.target.value.trim();
                  // Editing it back to the composed text drops the override.
                  props.onCommit({ promptOverride: value === composed.trim() ? null : value });
                }}
                disabled={props.busy}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {overridden
                  ? 'Yours. Regenerating the storyboard will not overwrite it.'
                  : 'Recomposed automatically when you change the camera, action or cast. Edit to override.'}
              </p>
            </div>

            {props.negativePrompt ? (
              <div>
                <Label className="text-xs">Negative prompt</Label>
                <p className="mt-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {props.negativePrompt}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
