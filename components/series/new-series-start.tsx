'use client';

import { useState } from 'react';
import { ChevronLeft, FileText, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CreateSeriesWizard } from './create-wizard';
import { ImportScriptWizard } from './import-script-wizard';

type Mode = 'generated' | 'user_provided';

/**
 * The fork at the top of a new series: write it, or bring it.
 *
 * Presented before either form so the choice is made while nothing exists yet —
 * the two paths ask for genuinely different things (a premise versus a script),
 * and a single form with half its fields disabled would be worse than a choice.
 */
export function NewSeriesStart() {
  const [mode, setMode] = useState<Mode | null>(null);

  if (mode === 'generated') return <WithBack onBack={() => setMode(null)}><CreateSeriesWizard /></WithBack>;
  if (mode === 'user_provided') {
    return (
      <WithBack onBack={() => setMode(null)}>
        <ImportScriptWizard />
      </WithBack>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ModeCard
        icon={<Sparkles className="size-5" />}
        title="Generate the script"
        description="Give a premise and the shape of the show. The model writes the bible, the cast and every episode. You review each stage."
        action="Start from a premise"
        onSelect={() => setMode('generated')}
      />
      <ModeCard
        icon={<FileText className="size-5" />}
        title="Use my own script"
        description="Paste or upload a script you have already written. It is broken into episodes, scenes and dialogue for you to check before anything is generated."
        action="Bring a script"
        onSelect={() => setMode('user_provided')}
      />
    </div>
  );
}

function ModeCard(props: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: string;
  onSelect: () => void;
}) {
  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-1 flex-col gap-3 p-6">
        <div className="flex size-10 items-center justify-center rounded-md bg-muted text-foreground">
          {props.icon}
        </div>
        <h2 className="font-medium">{props.title}</h2>
        <p className="flex-1 text-sm text-muted-foreground">{props.description}</p>
        <Button type="button" onClick={props.onSelect} className="mt-2 w-full">
          {props.action}
        </Button>
      </CardContent>
    </Card>
  );
}

function WithBack({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Choose a different way to start
      </button>
      {children}
    </div>
  );
}
