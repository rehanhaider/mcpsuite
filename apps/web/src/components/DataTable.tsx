/**
 * DataTable — TanStack Table v8 wrapper with server-side sort/pagination,
 * row selection for bulk actions, sticky header, skeleton loading and an
 * empty state. All list pages run through this.
 */
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "./ui.tsx";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { TABLE_CLASS, TableShell } from "./TableShell.tsx";

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T>[];
  total: number;
  loading?: boolean;
  /** Server-side sorting (single column). */
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;
  /** Server-side pagination. */
  page: number; // 0-based
  pageSize: number;
  onPageChange(page: number): void;
  onRowClick?(row: T): void;
  getRowId(row: T): string;
  /** Row selection for bulk actions (optional). */
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: OnChangeFn<RowSelectionState>;
  empty?: { title: string; hint?: string; action?: ReactNode };
}

export function DataTable<T>(props: DataTableProps<T>) {
  const selectable =
    props.rowSelection !== undefined &&
    props.onRowSelectionChange !== undefined;

  const table = useReactTable({
    data: props.data,
    columns: props.columns,
    state: {
      sorting: props.sorting,
      ...(selectable ? { rowSelection: props.rowSelection } : {}),
    },
    onSortingChange: props.onSortingChange,
    ...(selectable
      ? {
          onRowSelectionChange: props.onRowSelectionChange,
          enableRowSelection: true,
        }
      : {}),
    manualSorting: true,
    manualPagination: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: props.getRowId,
  });

  const pageCount = Math.max(1, Math.ceil(props.total / props.pageSize));
  const from = props.total === 0 ? 0 : props.page * props.pageSize + 1;
  const to = Math.min(props.total, (props.page + 1) * props.pageSize);

  if (!props.loading && props.total === 0) {
    return (
      <EmptyState
        title={props.empty?.title ?? "Nothing here yet"}
        hint={props.empty?.hint}
        action={props.empty?.action}
      />
    );
  }

  return (
    <TableShell
      footer={
        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <span className="tnum">
            {from}–{to} of {props.total}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={props.page === 0}
              onClick={() => props.onPageChange(props.page - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="tnum flex items-center px-1">
              {props.page + 1}/{pageCount}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={props.page + 1 >= pageCount}
              onClick={() => props.onPageChange(props.page + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      }
    >
      <table className={TABLE_CLASS}>
        <thead className="sticky top-0 z-[1] bg-card text-[11px] tracking-wider text-muted-foreground uppercase">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-border">
              {selectable ? (
                <th className="w-8 px-3 py-2">
                  <Checkbox
                    checked={table.getIsAllRowsSelected()}
                    indeterminate={table.getIsSomeRowsSelected()}
                    onCheckedChange={(checked) =>
                      table.toggleAllRowsSelected(checked)
                    }
                    aria-label="Select all"
                  />
                </th>
              ) : null}
              {hg.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const dir = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    className="px-3 py-2 text-left font-medium whitespace-nowrap"
                    style={{
                      width:
                        header.getSize() !== 150 ? header.getSize() : undefined,
                    }}
                  >
                    {canSort ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="-ml-2 h-6 gap-1 px-2 text-[11px] tracking-wider uppercase"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                        {dir === "asc" ? (
                          <ArrowUp className="size-3" />
                        ) : dir === "desc" ? (
                          <ArrowDown className="size-3" />
                        ) : null}
                      </Button>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {props.loading
            ? Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-b border-border/50">
                  {selectable ? (
                    <td className="px-3 py-2">
                      <div className="skeleton size-4 rounded" />
                    </td>
                  ) : null}
                  {props.columns.map((_c, j) => (
                    <td key={j} className="px-3 py-2">
                      <div
                        className="skeleton h-3.5 rounded"
                        style={{ width: `${45 + ((i * 13 + j * 29) % 40)}%` }}
                      />
                    </td>
                  ))}
                </tr>
              ))
            : table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={`border-b border-border/50 transition-colors last:border-0 hover:bg-foreground/[0.03] ${
                    props.onRowClick ? "cursor-pointer" : ""
                  } ${row.getIsSelected() ? "bg-primary/5" : ""}`}
                  onClick={() => props.onRowClick?.(row.original)}
                >
                  {selectable ? (
                    <td
                      className="px-3 py-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={row.getIsSelected()}
                        onCheckedChange={(checked) =>
                          row.toggleSelected(checked === true)
                        }
                        aria-label="Select row"
                      />
                    </td>
                  ) : null}
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 whitespace-nowrap">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </TableShell>
  );
}
