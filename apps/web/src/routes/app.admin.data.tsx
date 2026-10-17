import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Database, Download, Upload } from "lucide-react";
import { useRef, useState } from "react";
import type { ImportTargetField, Pipeline } from "@mcpsuite/core/domain";
import { IMPORT_TARGET_FIELDS } from "@mcpsuite/core/domain";
import { opQuery, useOp } from "~/lib/api.ts";
import { ButtonSpinner, Field, SectionCard } from "~/components/ui.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Input } from "~/components/ui/input.tsx";
import { NativeSelect as Select } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch.tsx";

export const Route = createFileRoute("/app/admin/data")({
  component: DataAdmin,
});

export interface ImportPreview {
  headers: string[];
  mapping: Record<string, ImportTargetField>;
  totalRows: number;
  importableRows: number;
  skippedRows: number;
  newCompanies: number;
  existingCompanyMatches: number;
  newPeople: number;
  existingPeopleMatches: number;
  sample: unknown[];
}

export interface ImportResult {
  companiesCreated: number;
  companiesMatched: number;
  peopleCreated: number;
  peopleMatched: number;
  engagementsCreated: number;
  engagementsSkipped: number;
  tag: string;
}

function DataAdmin() {
  return (
    <div className="space-y-4">
      <ImportCard />
      <ExportCard />
      <BackupCard />
    </div>
  );
}

function ImportCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const previewRequest = useRef<number>(0);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Record<
    string,
    ImportTargetField
  > | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const pipelines = useQuery(
    opQuery<Pipeline[]>("pipeline.list", { type: "engagement" }),
  );
  const [pipelineId, setPipelineId] = useState("");

  const runPreview = useOp("import.preview", {
    invalidate: false,
  });
  const runImport = useOp("import.run", {
    successToast: "Import complete",
    onSuccess: (r) => {
      setResult(r as ImportResult);
      setPreview(null);
      setCsv(null);
      setFileName("");
    },
  });

  function loadFile(file: File) {
    file.text().then((text) => {
      setCsv(text);
      setFileName(file.name);
      setResult(null);
      const request = ++previewRequest.current;
      runPreview.mutate({ csv: text }, {
        onSuccess: (r) => {
          if (request !== previewRequest.current) return;
          const p = r as ImportPreview;
          setPreview(p);
          setMapping(p.mapping);
        },
      });
    });
  }

  return (
    <SectionCard
      title="Import CSV"
      subtitle="Leads/companies/people from a spreadsheet. Columns are auto-mapped; adjust before running."
    >
      <Input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadFile(f);
          e.target.value = "";
        }}
      />
      {!csv ? (
        <Button
          type="button"
          variant="outline"
          className="h-auto w-full cursor-pointer flex-col gap-2 rounded-xl border-2 border-dashed py-8 text-muted-foreground hover:border-primary/40 hover:bg-transparent hover:text-foreground/70"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) loadFile(f);
          }}
        >
          <Upload className="size-6" />
          <span className="text-sm">Drop a CSV here or click to choose</span>
        </Button>
      ) : null}

      {csv && preview ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-4 text-sm">
            <span className="font-medium">{fileName}</span>
            <span className="text-muted-foreground">
              {preview.totalRows} rows
            </span>
            <span className="text-success">
              {preview.importableRows} importable
            </span>
            {preview.skippedRows > 0 ? (
              <span className="text-warning">
                {preview.skippedRows} skipped
              </span>
            ) : null}
            <ImportPreviewCounts preview={preview} />
          </div>

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left tracking-wider uppercase text-muted-foreground/70">
                  <th className="px-3 py-2 font-medium">CSV column</th>
                  <th className="px-3 py-2 font-medium">Maps to</th>
                </tr>
              </thead>
              <tbody>
                {preview.headers.map((h) => (
                  <tr
                    key={h}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="px-3 py-1.5 font-mono">{h}</td>
                    <td className="px-3 py-1.5">
                      <Select
                        size="xs"
                        className="w-auto font-mono"
                        value={mapping?.[h] ?? "skip"}
                        onChange={(e) => {
                          const next = {
                            ...(mapping ?? {}),
                            [h]: e.target.value as ImportTargetField,
                          };
                          setMapping(next);
                          const request = ++previewRequest.current;
                          runPreview.mutate({ csv, mapping: next }, {
                            onSuccess: (r) => {
                              if (request !== previewRequest.current) return;
                              setPreview(r as ImportPreview);
                            },
                          });
                        }}
                      >
                        {IMPORT_TARGET_FIELDS.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <Field label="Source label" hint="Tagged onto every imported lead.">
              <Input
                placeholder={`import-${new Date().toISOString().slice(0, 10)}`}
                value={sourceLabel}
                onChange={(e) => setSourceLabel(e.target.value)}
              />
            </Field>
            <Field label="Pipeline">
              <Select
                value={pipelineId}
                onChange={(e) => setPipelineId(e.target.value)}
              >
                <option value="">default</option>
                {(pipelines.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grow" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCsv(null);
                setPreview(null);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={runImport.isPending || runPreview.isPending || preview.importableRows === 0}
              onClick={() =>
                runImport.mutate({
                  csv,
                  mapping,
                  sourceLabel: sourceLabel.trim() || undefined,
                  pipelineId: pipelineId || undefined,
                })
              }
            >
              {runImport.isPending ? <ButtonSpinner /> : null}
              Run import
            </Button>
          </div>
        </div>
      ) : null}

      {csv && runPreview.isPending ? (
        <p className="text-sm text-muted-foreground">Analyzing CSV…</p>
      ) : null}

      {result ? <ImportResultSummary result={result} /> : null}
    </SectionCard>
  );
}

export function ImportPreviewCounts({ preview }: { preview: ImportPreview }) {
  return (
    <>
      <span className="text-muted-foreground">
        Companies: {preview.newCompanies} new ·{" "}
        {preview.existingCompanyMatches} matched
      </span>
      <span className="text-muted-foreground">
        People: {preview.newPeople} new ·{" "}
        {preview.existingPeopleMatches} matched
      </span>
    </>
  );
}

export function ImportResultSummary({ result }: { result: ImportResult }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-success/10 p-3 text-sm text-success">
      <span>
        Leads: {result.engagementsCreated} created ·{" "}
        {result.engagementsSkipped} skipped (already imported)
      </span>
      <span>
        Companies: {result.companiesCreated} new ·{" "}
        {result.companiesMatched} matched
      </span>
      <span>
        People: {result.peopleCreated} new · {result.peopleMatched} matched
      </span>
      <span>Tagged "{result.tag}"</span>
    </div>
  );
}

const EXPORTABLE = [
  "company",
  "person",
  "engagement",
  "deal",
  "activity",
] as const;

const EXPORT_LABELS: Record<(typeof EXPORTABLE)[number], string> = {
  company: "companies",
  person: "people",
  engagement: "leads",
  deal: "deals",
  activity: "activities",
};

function ExportCard() {
  const [entity, setEntity] =
    useState<(typeof EXPORTABLE)[number]>("engagement");
  const [includeArchived, setIncludeArchived] = useState(false);
  const exportCsv = useOp("export.csv", {
    invalidate: false,
    onSuccess: (r) => {
      const res = r as { entityType: string; rowCount: number; csv: string };
      const blob = new Blob([res.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mcpsuite-${res.entityType}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  return (
    <SectionCard
      title="Export CSV"
      subtitle="Full table export, downloads immediately."
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center rounded-lg border border-border p-0.5">
          {EXPORTABLE.map((e) => (
            <Button
              key={e}
              variant={entity === e ? "secondary" : "ghost"}
              size="xs"
              className="capitalize"
              onClick={() => setEntity(e)}
            >
              {EXPORT_LABELS[e]}
            </Button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={includeArchived}
            onCheckedChange={setIncludeArchived}
          />
          include archived
        </label>
        <div className="grow" />
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={exportCsv.isPending}
          onClick={() =>
            exportCsv.mutate({ entityType: entity, includeArchived })
          }
        >
          {exportCsv.isPending ? (
            <ButtonSpinner />
          ) : (
            <Download className="size-4" />
          )}
          Export
        </Button>
      </div>
    </SectionCard>
  );
}

function BackupCard() {
  const [path, setPath] = useState<string | null>(null);
  const backup = useOp("data.backup", {
    successToast: "Backup written",
    onSuccess: (r) => setPath((r as { path: string }).path),
  });
  return (
    <SectionCard
      title="Backup"
      subtitle="Consistent SQLite snapshot into data/backups/."
    >
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={backup.isPending}
          onClick={() => backup.mutate({})}
        >
          {backup.isPending ? (
            <ButtonSpinner />
          ) : (
            <Database className="size-4" />
          )}
          Backup now
        </Button>
        {path ? (
          <code className="font-mono text-xs text-muted-foreground">
            {path}
          </code>
        ) : null}
      </div>
    </SectionCard>
  );
}
