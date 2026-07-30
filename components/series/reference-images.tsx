'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { ImagePlus, Loader2, Sparkles, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ACCEPTED_IMAGE_TYPES,
  CANONICAL_REFERENCE_SET_SIZE,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
  isCanonicalAt,
  validateUploadBatch,
} from '@/lib/characters/references';
import { cn } from '@/lib/utils';

export interface ReferenceImage {
  id: string;
  url: string | null;
  bytes: number;
  isCanonical: boolean;
}

interface UploadTicket {
  uploadUrl: string;
  storagePath: string;
  filename: string;
}

/**
 * Reference stills for one character.
 *
 * The bytes never touch the Next.js server. The browser asks for signed upload
 * URLs, PUTs each file straight at object storage, and then tells the server
 * which paths landed so it can inspect them and record what it finds. That last
 * step is why an upload can still be refused *after* it has been sent — the
 * server's verdict is based on the stored object, not on what this component
 * claimed it was sending.
 */
export function ReferenceImages({
  characterId,
  characterName,
  initial,
}: {
  characterId: string;
  characterName: string;
  initial: ReferenceImage[];
}) {
  const [images, setImages] = useState(initial);
  const [busy, setBusy] = useState<null | 'uploading' | 'removing' | 'generating'>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const room = MAX_REFERENCE_IMAGES - images.length;
  const canonicalCount = images.filter((i) => i.isCanonical).length;

  async function upload(files: File[]) {
    // The same rules the server applies, run here first purely so the common
    // mistakes cost nothing. Nothing is trusted from this check.
    const check = validateUploadBatch(
      files.map((f) => ({ filename: f.name, contentType: f.type, bytes: f.size })),
      images.length,
    );
    if (!check.ok) {
      toast.error(check.message);
      return;
    }

    setBusy('uploading');
    try {
      const { uploads } = await postJson<{ uploads: UploadTicket[] }>(
        `/api/characters/${characterId}/reference-images/upload-urls`,
        {
          files: files.map((f) => ({ filename: f.name, contentType: f.type, bytes: f.size })),
        },
      );

      // Straight to storage, in parallel, bypassing this app entirely.
      await Promise.all(
        uploads.map(async (ticket, index) => {
          const file = files[index]!;
          const response = await fetch(ticket.uploadUrl, {
            method: 'PUT',
            headers: { 'content-type': file.type },
            body: file,
          });
          if (!response.ok) {
            throw new Error(`${file.name} could not be uploaded (${response.status}).`);
          }
        }),
      );

      const result = await postJson<{
        addedReferenceImages: ReferenceImage[];
        rejectedUploads: Array<{ reason: string }>;
      }>(
        `/api/characters/${characterId}`,
        { addReferenceImages: uploads.map((u) => u.storagePath) },
        'PATCH',
      );

      // The server re-sequences the whole set on every change, so take its
      // canonical flags rather than guessing at them here.
      setImages((prev) => reflag([...prev, ...result.addedReferenceImages]));

      for (const rejection of result.rejectedUploads ?? []) {
        toast.error(rejection.reason);
      }
      if (result.addedReferenceImages.length > 0) {
        toast.success(
          `Added ${result.addedReferenceImages.length} reference ${
            result.addedReferenceImages.length === 1 ? 'image' : 'images'
          } for ${characterName}.`,
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  /**
   * Generates the whole set from the character's appearance prompt.
   *
   * Replaces whatever is there, which is why it confirms first when images
   * already exist — a hand-picked set is work someone did, and losing it to a
   * misplaced click is worse than an extra dialog.
   */
  async function generate() {
    if (
      images.length > 0 &&
      !window.confirm(
        `Replace ${characterName}'s ${images.length} reference ` +
          `${images.length === 1 ? 'still' : 'stills'} with newly generated ones?`,
      )
    ) {
      return;
    }

    setBusy('generating');
    try {
      const result = await postJson<{ generated: number; costCents: number }>(
        `/api/characters/${characterId}/generate-stills`,
        {},
      );
      toast.success(
        `Generated ${result.generated} reference stills for ${characterName} ` +
          `(${result.costCents}c).`,
      );
      // The server owns order and canonical flags; take its word by reloading.
      window.location.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not generate stills.');
      setBusy(null);
    }
  }

  async function remove(imageId: string) {
    setBusy('removing');
    try {
      await postJson(`/api/characters/${characterId}`, { removeReferenceImageIds: [imageId] }, 'PATCH');
      setImages((prev) => reflag(prev.filter((i) => i.id !== imageId)));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove that image.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Reference stills</span>
        {canonicalCount > 0 ? (
          <Badge variant="success" className="gap-1">
            <Star className="size-3" />
            {canonicalCount} canonical
          </Badge>
        ) : (
          <Badge variant="outline">
            {CANONICAL_REFERENCE_SET_SIZE - images.length} more for a canonical set
          </Badge>
        )}
      </div>

      <p className="text-sm text-muted-foreground">
        The first {CANONICAL_REFERENCE_SET_SIZE} become the canonical set fed to the video model
        for character consistency. Generate them from the appearance prompt above, or upload your
        own — JPEG or PNG, up to {MAX_REFERENCE_IMAGE_BYTES / 1024 / 1024}MB each,{' '}
        {MAX_REFERENCE_IMAGES} maximum.
      </p>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={generate}
        disabled={busy !== null}
      >
        {busy === 'generating' ? <Loader2 className="animate-spin" /> : <Sparkles />}
        {images.length > 0 ? 'Regenerate stills' : 'Generate stills'}
      </Button>

      <div className="flex flex-wrap gap-2">
        {images.map((image) => (
          <figure
            key={image.id}
            className={cn(
              'relative size-24 overflow-hidden rounded-md border',
              image.isCanonical ? 'border-primary' : 'border-border',
            )}
          >
            {image.url ? (
              <Image
                src={image.url}
                alt=""
                fill
                sizes="96px"
                className="object-cover"
                unoptimized
              />
            ) : (
              <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
                unavailable
              </div>
            )}

            {image.isCanonical && (
              <Star className="absolute left-1 top-1 size-4 fill-primary text-primary" />
            )}

            <button
              type="button"
              aria-label="Remove this reference image"
              onClick={() => remove(image.id)}
              disabled={busy !== null}
              className="absolute bottom-1 right-1 rounded bg-background/90 p-1 text-muted-foreground hover:text-destructive disabled:opacity-50"
            >
              <Trash2 className="size-3.5" />
            </button>
          </figure>
        ))}

        {room > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInput.current?.click()}
            disabled={busy !== null}
            className="size-24 flex-col gap-1 border-dashed"
          >
            {busy === 'uploading' ? (
              <Loader2 className="animate-spin" />
            ) : (
              <>
                <ImagePlus />
                <span className="text-xs">Add {room}</span>
              </>
            )}
          </Button>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) void upload(files);
        }}
      />
    </div>
  );
}

/**
 * Mirrors the server's canonical rule so the badge is right immediately rather
 * than after a refresh. The server remains the authority — this only has to
 * agree with it, and `references.ts` is the shared definition.
 */
function reflag(images: ReferenceImage[]): ReferenceImage[] {
  return images.map((image, index) => ({
    ...image,
    isCanonical: isCanonicalAt(index, images.length),
  }));
}

async function postJson<T>(url: string, body: unknown, method: 'POST' | 'PATCH' = 'POST'): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message ?? `Request failed (${response.status}).`);
  }

  return (await response.json()) as T;
}
