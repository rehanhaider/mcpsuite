import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Workspace } from "@emcp/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { ButtonSpinner, Field, SectionCard, Spinner } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";

export const Route = createFileRoute("/app/admin/")({ component: WorkspaceSettings });

function WorkspaceSettings() {
  const ws = useQuery(opQuery<Workspace>("workspace.get"));
  if (ws.isLoading || !ws.data) return <Spinner />;
  return <SettingsForm workspace={ws.data} key={ws.data.updatedAt} />;
}

function SettingsForm({ workspace }: { workspace: Workspace }) {
  const [name, setName] = useState(workspace.name);
  const [currency, setCurrency] = useState(workspace.defaultCurrency);
  const [timezone, setTimezone] = useState(workspace.timezone);
  const [staleEng, setStaleEng] = useState(String(workspace.settings.staleEngagementDays));
  const [staleDeal, setStaleDeal] = useState(String(workspace.settings.staleDealDays));
  const update = useOp("workspace.update", { successToast: "Workspace saved" });
  const [dirty, setDirty] = useState(false);
  useEffect(() => setDirty(true), [name, currency, timezone, staleEng, staleDeal]);
  useEffect(() => setDirty(false), []);

  return (
    <div className="max-w-xl space-y-4">
      <SectionCard title="Workspace">
        <div className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Default currency" hint="ISO 4217 (USD, INR, EUR…)">
              <Input className="font-mono uppercase" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            </Field>
            <Field label="Timezone">
              <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </Field>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Staleness" subtitle="Records with no activity for this many days are flagged as stale.">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Leads (days)">
            <Input type="number" min={1} max={365} value={staleEng} onChange={(e) => setStaleEng(e.target.value)} />
          </Field>
          <Field label="Deals (days)">
            <Input type="number" min={1} max={365} value={staleDeal} onChange={(e) => setStaleDeal(e.target.value)} />
          </Field>
        </div>
      </SectionCard>

      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!dirty || update.isPending || !name.trim() || currency.length !== 3}
          onClick={() =>
            update.mutate(
              {
                name: name.trim(),
                defaultCurrency: currency,
                timezone: timezone.trim(),
                staleEngagementDays: Number(staleEng) || workspace.settings.staleEngagementDays,
                staleDealDays: Number(staleDeal) || workspace.settings.staleDealDays,
              },
              { onSuccess: () => setDirty(false) },
            )
          }
        >
          {update.isPending ? <ButtonSpinner /> : null}
          Save changes
        </Button>
      </div>
    </div>
  );
}
